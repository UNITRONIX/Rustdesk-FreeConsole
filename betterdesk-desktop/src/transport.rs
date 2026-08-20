use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async, tungstenite::Message as WsMessage, MaybeTlsStream, WebSocketStream,
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

impl WsBinaryTransport {
    pub async fn connect(url: Url) -> Result<Self> {
        anyhow::ensure!(
            matches!(url.scheme(), "ws" | "wss"),
            "transport URL must use ws or wss"
        );
        let (stream, _) =
            tokio::time::timeout(Duration::from_secs(15), connect_async(url.as_str()))
                .await
                .context("websocket connection timed out")??;
        Ok(Self {
            stream,
            max_frame_size: frame::MAX_FRAME_SIZE,
        })
    }

    pub async fn send_framed(&mut self, payload: &[u8]) -> Result<()> {
        let framed = frame::encode(payload).context("encode protocol frame")?;
        self.stream
            .send(WsMessage::Binary(framed.into()))
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
