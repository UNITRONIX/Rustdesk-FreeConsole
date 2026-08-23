use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::Message as WsMessage, Connector, MaybeTlsStream,
    WebSocketStream,
};
use url::Url;

use crate::{config::ServerConfig, frame};

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    Idle,
    Connecting,
    Authenticating,
    Connected,
    Reconnecting,
    Disconnected,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub state: SessionState,
    pub peer_id: String,
    pub transport: String,
    pub latency_ms: Option<u32>,
    pub capabilities: Vec<String>,
}

impl SessionSnapshot {
    pub fn idle(peer_id: impl Into<String>) -> Self {
        Self {
            state: SessionState::Idle,
            peer_id: peer_id.into(),
            transport: String::new(),
            latency_ms: None,
            capabilities: Vec::new(),
        }
    }
}

pub struct WsBinaryTransport {
    stream: WsStream,
    max_frame_size: usize,
}

#[derive(Debug)]
struct AcceptAnyCertificate;

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

impl WsBinaryTransport {
    pub async fn connect(url: Url, allow_untrusted_tls: bool) -> Result<Self> {
        anyhow::ensure!(
            matches!(url.scheme(), "ws" | "wss"),
            "transport URL must use ws or wss"
        );
        crate::ensure_tls_provider();
        let fallback_scheme = if url.scheme() == "ws" { "wss" } else { "ws" };
        let mut candidates = vec![url.clone()];
        let mut fallback = url.clone();
        fallback
            .set_scheme(fallback_scheme)
            .map_err(|_| anyhow::anyhow!("invalid websocket fallback URL"))?;
        candidates.push(fallback);

        let mut last_error = None;
        for candidate in candidates {
            let connector = if allow_untrusted_tls {
                let tls_config = ClientConfig::builder()
                    .dangerous()
                    .with_custom_certificate_verifier(std::sync::Arc::new(AcceptAnyCertificate))
                    .with_no_client_auth();
                Some(Connector::Rustls(std::sync::Arc::new(tls_config)))
            } else {
                None
            };
            match tokio::time::timeout(
                Duration::from_secs(15),
                connect_async_tls_with_config(candidate.as_str(), None, false, connector),
            )
            .await
            {
                Ok(Ok((stream, _))) => {
                    return Ok(Self {
                        stream,
                        max_frame_size: frame::MAX_FRAME_SIZE,
                    });
                }
                Ok(Err(error)) => last_error = Some(error.to_string()),
                Err(_) => last_error = Some("connection timed out".to_owned()),
            }
        }
        Err(anyhow::anyhow!(
            "websocket connection failed: {}",
            last_error.unwrap_or_else(|| "unknown error".to_owned())
        ))
    }

    /// Send one raw protobuf payload in a WebSocket binary message.
    ///
    /// WebSocket already provides message boundaries. The variable-length
    /// prefix used by the native TCP protocol must not be added here.
    pub async fn send_raw(&mut self, payload: &[u8]) -> Result<()> {
        self.stream
            .send(WsMessage::Binary(payload.to_vec().into()))
            .await
            .context("send protocol frame")
    }

    pub async fn next_binary(&mut self) -> Result<Option<Vec<u8>>> {
        while let Some(message) = self.stream.next().await {
            match message.context("receive websocket message")? {
                WsMessage::Binary(bytes) => {
                    anyhow::ensure!(
                        bytes.len() <= self.max_frame_size + 4,
                        "received websocket payload exceeds limit"
                    );
                    return Ok(Some(bytes.to_vec()));
                }
                WsMessage::Close(_) => return Ok(None),
                WsMessage::Ping(payload) => {
                    self.stream.send(WsMessage::Pong(payload)).await?;
                }
                WsMessage::Pong(_) => {}
                WsMessage::Text(_) => {}
                WsMessage::Frame(_) => {}
            }
        }
        Ok(None)
    }

    pub async fn close(&mut self) -> Result<()> {
        self.stream
            .send(WsMessage::Close(None))
            .await
            .context("close websocket")
    }
}

pub fn encode_message<M: Message>(message: &M) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(message.encoded_len());
    message
        .encode(&mut bytes)
        .context("encode protobuf message")?;
    Ok(bytes)
}

pub struct RustDeskEndpoints {
    pub rendezvous: Url,
    pub relay: Url,
}

impl RustDeskEndpoints {
    pub fn from_config(config: &ServerConfig) -> Result<Self> {
        Ok(Self {
            rendezvous: config
                .rustdesk_signal_url()
                .context("build rendezvous endpoint")?,
            relay: config
                .rustdesk_relay_url()
                .context("build relay endpoint")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_paths_are_stable() {
        let config = ServerConfig {
            id_server: "desk.example.test:21116".into(),
            api_url: "https://desk.example.test".into(),
            ..Default::default()
        };
        let endpoints = RustDeskEndpoints::from_config(&config).unwrap();
        assert_eq!(endpoints.rendezvous.port(), Some(21118));
        assert_eq!(endpoints.relay.port(), Some(21119));
    }

    #[test]
    fn snapshot_defaults_to_idle() {
        assert_eq!(SessionSnapshot::idle("BD-1").state, SessionState::Idle);
    }
}
