use anyhow::{bail, Context, Result};
use prost::Message;
use uuid::Uuid;

use crate::{
    config::ServerConfig,
    crypto::{self, KeyExchange, SecretBoxStream},
    hbb::{message, relay_response, rendezvous_message, Message as PeerMessage, RendezvousMessage},
    rustdesk,
    transport::{RustDeskEndpoints, SessionSnapshot, SessionState, WsBinaryTransport},
};

/// Native RustDesk-compatible rendezvous/relay session.
///
/// The method intentionally stops after the peer identity is received. Password
/// authentication and media channels are layered on top of this object so a
/// failed identity check can never turn into an active session.
pub struct RustDeskSession {
    device_id: String,
    server_key: String,
    relay_uuid: String,
    peer_signed_key: Option<Vec<u8>>,
    relay: WsBinaryTransport,
    key_exchange: Option<KeyExchange>,
    crypto: Option<SecretBoxStream>,
    snapshot: SessionSnapshot,
}

impl RustDeskSession {
    /// Register the durable device public key before accepting sessions.
    ///
    /// The rendezvous server stores only the public key and returns its
    /// keep-alive interval. Media and input remain end-to-end peer traffic.
    pub async fn register_device(
        config: &ServerConfig,
        device_id: &str,
        device_uuid: &[u8],
        public_key: &[u8],
    ) -> Result<i32> {
        let (mut rendezvous, keep_alive) =
            Self::register_device_connection(config, device_id, device_uuid, public_key).await?;
        rendezvous.close().await?;
        Ok(keep_alive)
    }

    pub async fn register_device_connection(
        config: &ServerConfig,
        device_id: &str,
        device_uuid: &[u8],
        public_key: &[u8],
    ) -> Result<(WsBinaryTransport, i32)> {
        config
            .validate()
            .context("validate BetterDesk configuration")?;
        let endpoints = RustDeskEndpoints::from_config(config)?;
        let mut rendezvous =
            WsBinaryTransport::connect(endpoints.rendezvous, config.allow_untrusted_tls).await?;
        rendezvous
            .send_raw(&rustdesk::encode(&rustdesk::register_pk_request(
                device_id,
                device_uuid,
                public_key,
            )))
            .await
            .context("send RegisterPk")?;

        while let Some(bytes) = rendezvous.next_binary().await? {
            if bytes.is_empty() {
                continue;
            }
            let response = RendezvousMessage::decode(bytes.as_slice())?;
            if let Some(rendezvous_message::Union::RegisterPkResponse(response)) = response.union {
                if response.result != 0 {
                    bail!(
                        "device registration refused with result {}",
                        response.result
                    );
                }
                return Ok((rendezvous, response.keep_alive));
            }
        }
        bail!("rendezvous closed before RegisterPkResponse")
    }

    pub async fn connect(config: &ServerConfig, device_id: &str) -> Result<Self> {
        config
            .validate()
            .context("validate BetterDesk configuration")?;
        let endpoints = RustDeskEndpoints::from_config(config)?;
        let mut rendezvous =
            WsBinaryTransport::connect(endpoints.rendezvous, config.allow_untrusted_tls).await?;
        let request = rustdesk::punch_hole_request(device_id, &config.server_key);
        rendezvous
            .send_raw(&rustdesk::encode(&request))
            .await
            .context("send PunchHoleRequest")?;

        let mut relay_uuid = String::new();
        let mut relay_server = config.relay_server.clone();
        let mut peer_signed_key = None;
        loop {
            let Some(bytes) = rendezvous.next_binary().await? else {
                bail!("rendezvous closed before a peer response");
            };
            if bytes.is_empty() {
                continue;
            }
            let message = RendezvousMessage::decode(bytes.as_slice())?;
            let Some(union) = message.union else {
                continue;
            };
            match union {
                rendezvous_message::Union::PunchHoleResponse(response) => {
                    let has_relay = !response.relay_server.is_empty();
                    let has_direct = !response.socket_addr.is_empty();
                    if has_relay {
                        relay_server = response.relay_server.clone();
                    }
                    if !has_relay && !has_direct {
                        bail!(
                            "peer unavailable: {}",
                            if response.other_failure.is_empty() {
                                "no relay or direct address"
                            } else {
                                response.other_failure.as_str()
                            }
                        );
                    }
                    relay_uuid = Uuid::new_v4().to_string();
                    let relay_request = rustdesk::request_relay(
                        device_id,
                        &relay_uuid,
                        &relay_server,
                        &config.server_key,
                    );
                    rendezvous
                        .send_raw(&rustdesk::encode(&relay_request))
                        .await?;
                }
                rendezvous_message::Union::RelayResponse(response) => {
                    if !response.refuse_reason.is_empty() {
                        bail!("relay refused: {}", response.refuse_reason);
                    }
                    if !response.uuid.is_empty() {
                        relay_uuid = response.uuid;
                    }
                    if !response.relay_server.is_empty() {
                        relay_server = response.relay_server;
                    }
                    peer_signed_key = match response.union {
                        Some(relay_response::Union::Pk(pk)) if !pk.is_empty() => Some(pk),
                        _ => None,
                    };
                    break;
                }
                _ => {}
            }
            if !relay_uuid.is_empty() && !relay_server.is_empty() {
                break;
            }
        }
        rendezvous.close().await?;

        let relay_url = endpoints.relay;
        let mut relay = WsBinaryTransport::connect(relay_url, config.allow_untrusted_tls).await?;
        let relay_request =
            rustdesk::request_relay(device_id, &relay_uuid, &relay_server, &config.server_key);
        relay.send_raw(&rustdesk::encode(&relay_request)).await?;

        Ok(Self {
            device_id: device_id.to_owned(),
            server_key: config.server_key.clone(),
            relay_uuid,
            peer_signed_key,
            relay,
            key_exchange: None,
            crypto: None,
            snapshot: SessionSnapshot {
                state: SessionState::Connecting,
                peer_id: device_id.to_owned(),
                transport: "RustDesk-compatible".to_owned(),
                latency_ms: None,
                capabilities: rustdesk::CAPABILITIES
                    .iter()
                    .map(|capability| (*capability).to_owned())
                    .collect(),
            },
        })
    }

    pub fn snapshot(&self) -> &SessionSnapshot {
        &self.snapshot
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn relay_uuid(&self) -> &str {
        &self.relay_uuid
    }

    pub fn server_key(&self) -> &str {
        &self.server_key
    }

    pub async fn next_peer_message(&mut self) -> Result<Option<PeerMessage>> {
        loop {
            let Some(bytes) = self.relay.next_binary().await? else {
                self.snapshot.state = SessionState::Disconnected;
                return Ok(None);
            };
            if bytes.is_empty() {
                continue;
            }
            if let Ok(rendezvous) = RendezvousMessage::decode(bytes.as_slice()) {
                if matches!(
                    rendezvous.union,
                    Some(rendezvous_message::Union::RelayResponse(_))
                ) {
                    continue;
                }
            }
            let plaintext = if let Some(cipher) = self.crypto.as_mut() {
                match cipher.try_decrypt(&bytes) {
                    Ok((sequence, plaintext)) => {
                        cipher.commit_receive(sequence);
                        plaintext
                    }
                    Err(_) => bytes,
                }
            } else {
                bytes
            };
            let message = PeerMessage::decode(plaintext.as_slice())?;
            if let Some(message::Union::SignedId(signed_id)) = message.union.as_ref() {
                self.verify_peer_identity(&signed_id.id)?;
                let (_, payload) = rustdesk::split_signed_id(&signed_id.id)
                    .context("peer identity payload is truncated")?;
                let peer_key = crate::hbb::IdPk::decode(payload)?;
                let mut exchange = KeyExchange::generate();
                exchange.set_peer_key(
                    peer_key.pk[..]
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("peer ephemeral key has an invalid length"))?,
                );
                self.relay
                    .send_raw(&rustdesk::encode(&rustdesk::public_key_message(&exchange)))
                    .await
                    .context("send PublicKey key exchange message")?;
                self.crypto = Some(SecretBoxStream::new(exchange.symmetric_key()));
                self.key_exchange = Some(exchange);
                self.snapshot.state = SessionState::Authenticating;
            }
            return Ok(Some(message));
        }
    }

    pub async fn authenticate(
        &mut self,
        password: &str,
        salt: &str,
        challenge: &str,
    ) -> Result<()> {
        let message = rustdesk::login_request(
            &self.device_id,
            crypto::hash_password(password, salt, challenge).to_vec(),
            uuid::Uuid::new_v4().as_u128() as u64,
        );
        let mut bytes = rustdesk::encode(&message);
        if let Some(cipher) = self.crypto.as_mut() {
            bytes = cipher.encrypt(&bytes)?;
        }
        self.relay.send_raw(&bytes).await?;
        Ok(())
    }

    pub async fn send_message(&mut self, message: &PeerMessage) -> Result<()> {
        let mut bytes = rustdesk::encode(message);
        if let Some(cipher) = self.crypto.as_mut() {
            bytes = cipher.encrypt(&bytes)?;
        }
        self.relay.send_raw(&bytes).await?;
        Ok(())
    }

    fn verify_peer_identity(&self, signed_id: &[u8]) -> Result<()> {
        let Some((signature, payload)) = rustdesk::split_signed_id(signed_id) else {
            bail!("peer identity message is truncated");
        };
        let Some(server_key) = self.peer_signed_key.as_deref() else {
            bail!("server did not provide a peer identity key");
        };
        let peer_id_pk = crate::hbb::IdPk::decode(payload)?;
        if peer_id_pk.pk.len() != 32 {
            bail!("peer ephemeral key has an invalid length");
        }
        let Some((server_signature, server_payload)) = rustdesk::split_signed_id(server_key) else {
            bail!("server peer identity message is truncated");
        };
        let server_id_pk = crate::hbb::IdPk::decode(server_payload)?;
        if server_id_pk.pk.len() != 32 {
            bail!("server peer identity key has an invalid length");
        }
        let server_public_key = crate::config::decode_public_key(&self.server_key)
            .context("decode configured server public key")?;
        crypto::verify_signature(&server_public_key, server_signature, server_payload)
            .context("verify server-signed peer identity")?;
        crypto::verify_signature(&server_id_pk.pk, signature, payload)
            .context("verify peer-signed ephemeral key")?;
        Ok(())
    }
}
