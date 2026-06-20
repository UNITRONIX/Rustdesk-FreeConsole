//! E2E chat encryption — X25519 ECDH + XSalsa20-Poly1305 (NaCl box).
//!
//! Matches the Go server implementation in `betterdesk-server/cdap/crypto.go`.
//! Key exchange flow:
//!   1. Agent generates an X25519 keypair on first start; persisted to keyring.
//!   2. On CDAP connection agent sends `key_exchange { type:"offer", public_key }`.
//!   3. Server forwards offer to the operator panel; operator's ECDH public key
//!      arrives as `key_exchange { type:"answer", public_key }`.
//!   4. Shared secret = ECDH(localPriv, remotePub).
//!   5. Every chat message is encrypted with `crypto_box::seal` (random nonce).

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ── Serialisable keypair ──────────────────────────────────────────────────

/// X25519 keypair stored in the keyring / config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatKeyPair {
    /// Base64-encoded 32-byte X25519 public key.
    pub public_key_b64: String,
    /// Base64-encoded 32-byte X25519 secret key.
    secret_key_b64: String,
}

impl ChatKeyPair {
    /// Generate a new random keypair.
    pub fn generate() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        let public = secret.public_key();
        ChatKeyPair {
            public_key_b64: B64.encode(public.as_bytes()),
            secret_key_b64: B64.encode(secret.to_bytes()),
        }
    }

    /// Restore from stored Base64 values.
    pub fn from_b64(pub_b64: &str, priv_b64: &str) -> Result<Self> {
        // Validate both keys decode to 32 bytes.
        let pub_bytes = B64.decode(pub_b64).context("public key decode")?;
        let priv_bytes = B64.decode(priv_b64).context("secret key decode")?;
        if pub_bytes.len() != 32 || priv_bytes.len() != 32 {
            return Err(anyhow!("Key length mismatch (expected 32 bytes)"));
        }
        Ok(ChatKeyPair {
            public_key_b64: pub_b64.to_string(),
            secret_key_b64: priv_b64.to_string(),
        })
    }

    fn secret_key(&self) -> Result<SecretKey> {
        let bytes: [u8; 32] = B64
            .decode(&self.secret_key_b64)
            .context("secret key decode")?
            .try_into()
            .map_err(|_| anyhow!("secret key bad length"))?;
        Ok(SecretKey::from(bytes))
    }

    #[allow(dead_code)]
    fn public_key(&self) -> Result<PublicKey> {
        let bytes: [u8; 32] = B64
            .decode(&self.public_key_b64)
            .context("public key decode")?
            .try_into()
            .map_err(|_| anyhow!("public key bad length"))?;
        Ok(PublicKey::from(bytes))
    }
}

// ── Encrypted message ─────────────────────────────────────────────────────

/// Wire format for an encrypted chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedMessage {
    /// Base64-encoded 24-byte nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext (XSalsa20-Poly1305).
    pub ciphertext: String,
    /// Sender's public key (Base64) so the receiver can derive the box.
    pub sender_pub: String,
}

// ── Chat crypto session ───────────────────────────────────────────────────

/// Active E2E chat session between this agent and one operator.
#[allow(dead_code)]
struct Session {
    local_keypair: ChatKeyPair,
    /// Derived SalsaBox once remote public key is known.
    salsa_box: Option<SalsaBox>,
    remote_pub_b64: Option<String>,
}

/// Thread-safe E2E chat crypto state.
pub struct ChatCrypto {
    inner: Mutex<Inner>,
}

struct Inner {
    keypair: ChatKeyPair,
    session: Option<Session>,
}

impl ChatCrypto {
    /// Initialise with a persistent keypair (generate if None).
    pub fn new(stored_keypair: Option<ChatKeyPair>) -> Self {
        let keypair = stored_keypair.unwrap_or_else(ChatKeyPair::generate);
        ChatCrypto {
            inner: Mutex::new(Inner {
                keypair,
                session: None,
            }),
        }
    }

    /// Return our X25519 public key in Base64 (for the key_exchange offer).
    pub fn public_key_b64(&self) -> String {
        self.inner.lock().unwrap().keypair.public_key_b64.clone()
    }

    /// Persist the keypair (call after generating a new one).
    pub fn export_keypair(&self) -> ChatKeyPair {
        self.inner.lock().unwrap().keypair.clone()
    }

    /// Accept the remote party's public key and derive the shared secret.
    pub fn accept_remote_key(&self, remote_pub_b64: &str) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let local_secret = inner.keypair.secret_key()?;

        let remote_bytes: [u8; 32] = B64
            .decode(remote_pub_b64)
            .context("remote pub key decode")?
            .try_into()
            .map_err(|_| anyhow!("remote public key bad length"))?;
        let remote_pub = PublicKey::from(remote_bytes);

        let salsa_box = SalsaBox::new(&remote_pub, &local_secret);

        inner.session = Some(Session {
            local_keypair: inner.keypair.clone(),
            salsa_box: Some(salsa_box),
            remote_pub_b64: Some(remote_pub_b64.to_string()),
        });

        Ok(())
    }

    /// Encrypt a plaintext string.  Returns `Err` if no session established.
    pub fn encrypt(&self, plaintext: &str) -> Result<EncryptedMessage> {
        let inner = self.inner.lock().unwrap();
        let session = inner.session.as_ref().ok_or_else(|| anyhow!("No E2E session"))?;
        let salsa = session
            .salsa_box
            .as_ref()
            .ok_or_else(|| anyhow!("E2E box not ready"))?;

        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ciphertext = salsa
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| anyhow!("encrypt error: {:?}", e))?;

        Ok(EncryptedMessage {
            nonce: B64.encode(nonce.as_slice()),
            ciphertext: B64.encode(&ciphertext),
            sender_pub: inner.keypair.public_key_b64.clone(),
        })
    }

    /// Decrypt an `EncryptedMessage`.  Returns `Err` if decryption fails.
    pub fn decrypt(&self, msg: &EncryptedMessage) -> Result<String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.session.as_ref().ok_or_else(|| anyhow!("No E2E session"))?;
        let salsa = session
            .salsa_box
            .as_ref()
            .ok_or_else(|| anyhow!("E2E box not ready"))?;

        let nonce_bytes: [u8; 24] = B64
            .decode(&msg.nonce)
            .context("nonce decode")?
            .try_into()
            .map_err(|_| anyhow!("nonce bad length"))?;
        let nonce = crypto_box::Nonce::from(nonce_bytes);

        let ciphertext = B64.decode(&msg.ciphertext).context("ciphertext decode")?;

        let plaintext = salsa
            .decrypt(&nonce, ciphertext.as_slice())
            .map_err(|e| anyhow!("decrypt error: {:?}", e))?;

        String::from_utf8(plaintext).context("plaintext not UTF-8")
    }

    /// True if a shared session has been established with the remote party.
    pub fn has_session(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .session
            .as_ref()
            .map_or(false, |s| s.salsa_box.is_some())
    }
}
