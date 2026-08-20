use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue},
        Message as WsMessage,
    },
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

#[derive(Debug, Error)]
pub enum CdapError {
    #[error("CDAP credential is empty")]
    EmptyCredential,
    #[error("CDAP server URL is invalid")]
    InvalidUrl,
    #[error("unsupported CDAP URL scheme")]
    UnsupportedScheme,
    #[error("CDAP message is too large")]
    MessageTooLarge,
    #[error("unknown CDAP binary frame type")]
    InvalidBinaryType,
    #[error("unsupported CDAP authentication method")]
    UnsupportedAuthMethod,
}

pub const PROTOCOL_VERSION: &str = "0.3.0";
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const CAPABILITIES: &[&str] = &[
    "telemetry",
    "remote_desktop",
    "keyboard_input",
    "mouse_input",
    "clipboard",
    "file_transfer",
    "audio",
    "multi_monitor",
    "unattended_access",
];

#[derive(Debug, Clone, Serialize)]
pub struct AuthMessage {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub payload: serde_json::Value,
}

impl AuthMessage {
    pub fn new(device_id: &str, auth_method: &str, credentials: &str) -> Result<Self, CdapError> {
        if credentials.trim().is_empty() {
            return Err(CdapError::EmptyCredential);
        }
        let mut payload = serde_json::json!({
            "method": auth_method,
            "device_id": device_id,
            "client_version": crate::rustdesk::CLIENT_VERSION,
            "protocol_version": PROTOCOL_VERSION,
        });
        match auth_method {
            "api_key" => payload["key"] = serde_json::json!(credentials),
            "device_token" => payload["token"] = serde_json::json!(credentials),
            "user_password" => payload["password"] = serde_json::json!(credentials),
            _ => return Err(CdapError::UnsupportedAuthMethod),
        }
        Ok(Self {
            message_type: "auth",
            payload,
        })
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AuthResponse {
    #[serde(rename = "type")]
    pub message_type: String,
    pub success: bool,
    #[serde(default)]
    pub server_version: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CdapMessage {
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "payload")]
    pub payload: serde_json::Value,
}

impl CdapMessage {
    pub fn to_text(&self) -> Result<String, CdapError> {
        let text = serde_json::to_string(self).map_err(|_| CdapError::MessageTooLarge)?;
        if text.len() > MAX_MESSAGE_BYTES {
            return Err(CdapError::MessageTooLarge);
        }
        Ok(text)
    }
}

pub fn device_manifest(device_id: &str) -> CdapMessage {
    let manifest = serde_json::json!({
        "manifest_version": "1.0",
        "device": {
            "id": device_id,
            "name": "BetterDesk Desktop",
            "type": "desktop",
            "vendor": "UNITRONIX",
            "model": "BetterDesk Desktop",
        },
        "capabilities": CAPABILITIES,
        "heartbeat_interval": 15,
        "widgets": [
            {"id": "remote_desktop", "type": "desktop", "label": "Remote desktop"},
            {"id": "file_browser", "type": "file_browser", "label": "File browser"},
            {"id": "clipboard", "type": "text", "label": "Clipboard"},
        ],
    });
    CdapMessage {
        message_type: "register".to_owned(),
        payload: serde_json::json!({"manifest": manifest}),
    }
}

pub fn endpoint(base: &str) -> Result<Url, CdapError> {
    let had_explicit_scheme = base.contains("://");
    let mut url = if base.contains("://") {
        Url::parse(base).map_err(|_| CdapError::InvalidUrl)?
    } else {
        Url::parse(&format!("https://{base}")).map_err(|_| CdapError::InvalidUrl)?
    };
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "ws" | "wss" => url.scheme(),
        _ => return Err(CdapError::UnsupportedScheme),
    }
    .to_owned();
    url.set_scheme(&scheme).map_err(|_| CdapError::InvalidUrl)?;
    if matches!(url.port(), Some(21114 | 21121)) {
        url.set_port(Some(21122))
            .map_err(|_| CdapError::InvalidUrl)?;
    } else if !had_explicit_scheme && url.port().is_none() {
        // A bare native server URL points at the dedicated CDAP gateway.
        url.set_port(Some(21122))
            .map_err(|_| CdapError::InvalidUrl)?;
    }
    url.set_path("/cdap");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BinaryFrameType {
    Video = 1,
    Audio = 2,
    Cursor = 3,
}

pub enum CdapEvent {
    Json(CdapMessage),
    Binary {
        frame_type: BinaryFrameType,
        payload: Vec<u8>,
    },
}

pub struct CdapSession {
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}

impl CdapSession {
    pub async fn connect(
        base: &str,
        device_id: &str,
        auth_method: &str,
        credentials: &str,
    ) -> Result<(Self, AuthResponse), anyhow::Error> {
        let url = endpoint(base)?;
        let mut request = url.as_str().into_client_request()?;
        request
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("cdap-v1"));
        let (mut stream, _) = connect_async(request).await?;
        let auth = AuthMessage::new(device_id, auth_method, credentials)?;
        let text = serde_json::to_string(&auth)?;
        stream.send(WsMessage::Text(text.into())).await?;

        let response = loop {
            let Some(message) = stream.next().await else {
                anyhow::bail!("CDAP server closed before auth response");
            };
            match message? {
                WsMessage::Text(text) => break parse_auth_response(&text)?,
                WsMessage::Ping(payload) => stream.send(WsMessage::Pong(payload)).await?,
                WsMessage::Close(_) => anyhow::bail!("CDAP server closed before auth response"),
                WsMessage::Binary(_) | WsMessage::Pong(_) | WsMessage::Frame(_) => {}
            }
        };
        if !response.success {
            anyhow::bail!("CDAP authentication failed");
        }
        let mut session = Self { stream };
        session.send_json(&device_manifest(device_id)).await?;
        Ok((session, response))
    }

    pub async fn send_json(&mut self, message: &CdapMessage) -> Result<(), anyhow::Error> {
        self.stream
            .send(WsMessage::Text(message.to_text()?.into()))
            .await?;
        Ok(())
    }

    pub async fn send_binary(
        &mut self,
        frame_type: BinaryFrameType,
        payload: &[u8],
    ) -> Result<(), anyhow::Error> {
        if payload.len() + 1 > MAX_MESSAGE_BYTES {
            anyhow::bail!("CDAP binary frame is too large");
        }
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(frame_type as u8);
        frame.extend_from_slice(payload);
        self.stream.send(WsMessage::Binary(frame.into())).await?;
        Ok(())
    }

    pub async fn send_heartbeat(&mut self) -> Result<(), anyhow::Error> {
        self.send_json(&CdapMessage {
            message_type: "heartbeat".to_owned(),
            payload: serde_json::json!({}),
        })
        .await
    }

    pub async fn next_event(&mut self) -> Result<Option<CdapEvent>, anyhow::Error> {
        loop {
            let Some(message) = self.stream.next().await else {
                return Ok(None);
            };
            match message? {
                WsMessage::Text(text) => {
                    return Ok(Some(CdapEvent::Json(serde_json::from_str(&text)?)));
                }
                WsMessage::Binary(bytes) => {
                    if bytes.is_empty() {
                        anyhow::bail!("empty CDAP binary frame");
                    }
                    let frame_type = BinaryFrameType::try_from(bytes[0])?;
                    return Ok(Some(CdapEvent::Binary {
                        frame_type,
                        payload: bytes[1..].to_vec(),
                    }));
                }
                WsMessage::Ping(payload) => {
                    self.stream.send(WsMessage::Pong(payload)).await?;
                }
                WsMessage::Close(_) => return Ok(None),
                WsMessage::Pong(_) | WsMessage::Frame(_) => {}
            }
        }
    }

    pub async fn close(&mut self) -> Result<(), anyhow::Error> {
        self.stream.send(WsMessage::Close(None)).await?;
        Ok(())
    }
}

fn parse_auth_response(text: &str) -> Result<AuthResponse, anyhow::Error> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    if value["type"] == "auth_result" && value["payload"].is_object() {
        let mut payload = value["payload"].clone();
        payload["type"] = value["type"].clone();
        return Ok(serde_json::from_value(payload)?);
    }
    Ok(serde_json::from_value(value)?)
}

impl TryFrom<u8> for BinaryFrameType {
    type Error = CdapError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Video),
            2 => Ok(Self::Audio),
            3 => Ok(Self::Cursor),
            _ => Err(CdapError::InvalidBinaryType),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_has_protocol_version() {
        let auth = AuthMessage::new("BD-1", "device_token", "secret").unwrap();
        let json = serde_json::to_value(auth).unwrap();
        assert_eq!(json["type"], "auth");
        assert_eq!(json["payload"]["protocol_version"], PROTOCOL_VERSION);
    }

    #[test]
    fn endpoint_maps_https_to_wss() {
        assert_eq!(
            endpoint("https://desk.example.test").unwrap().as_str(),
            "wss://desk.example.test/cdap"
        );
    }

    #[test]
    fn endpoint_maps_direct_api_port_to_cdap_gateway() {
        let url = endpoint("http://desk.example.test:21114").unwrap();
        assert_eq!(url.as_str(), "ws://desk.example.test:21122/cdap");
    }

    #[test]
    fn desktop_manifest_advertises_bidirectional_capabilities() {
        let manifest = device_manifest("123456789");
        assert_eq!(manifest.message_type, "register");
        assert!(manifest.payload["manifest"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "remote_desktop"));
    }
}
