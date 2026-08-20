use crypto_box::{
    aead::{Aead, KeyInit, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use crypto_secretbox::{Key, Nonce, XSalsa20Poly1305};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid key material")]
    InvalidKey,
    #[error("authenticated encryption failed")]
    EncryptionFailed,
    #[error("authenticated decryption failed")]
    DecryptionFailed,
    #[error("signature verification failed")]
    InvalidSignature,
}

pub struct KeyExchange {
    secret_key: SecretKey,
    peer_key: Option<PublicKey>,
    symmetric_key: [u8; 32],
}

impl KeyExchange {
    pub fn generate() -> Self {
        let secret_key = SecretKey::generate(&mut OsRng);
        let mut symmetric_key = [0_u8; 32];
        getrandom::fill(&mut symmetric_key).expect("OS random source unavailable");
        Self {
            secret_key,
            peer_key: None,
            symmetric_key,
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        *self.secret_key.public_key().as_bytes()
    }

    pub fn set_peer_key(&mut self, key: [u8; 32]) {
        self.peer_key = Some(PublicKey::from(key));
    }

    pub fn encrypted_symmetric_key(&self) -> Result<Vec<u8>, CryptoError> {
        let peer = self.peer_key.as_ref().ok_or(CryptoError::InvalidKey)?;
        let cipher = SalsaBox::new(peer, &self.secret_key);
        let zero_nonce = [0_u8; 24];
        cipher
            .encrypt(
                crypto_box::Nonce::from_slice(&zero_nonce),
                self.symmetric_key.as_slice(),
            )
            .map_err(|_| CryptoError::EncryptionFailed)
    }

    pub fn symmetric_key(&self) -> [u8; 32] {
        self.symmetric_key
    }
}

pub struct SecretBoxStream {
    key: Key,
    send_sequence: u64,
    receive_sequence: u64,
}

impl SecretBoxStream {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key: *Key::from_slice(&key),
            send_sequence: 0,
            receive_sequence: 0,
        }
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.send_sequence = self
            .send_sequence
            .checked_add(1)
            .ok_or(CryptoError::InvalidKey)?;
        let nonce = nonce(self.send_sequence);
        XSalsa20Poly1305::new(&self.key)
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| CryptoError::EncryptionFailed)
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let next = self
            .receive_sequence
            .checked_add(1)
            .ok_or(CryptoError::InvalidKey)?;
        let plaintext = XSalsa20Poly1305::new(&self.key)
            .decrypt(Nonce::from_slice(&nonce(next)), ciphertext)
            .map_err(|_| CryptoError::DecryptionFailed)?;
        self.receive_sequence = next;
        Ok(plaintext)
    }

    pub fn try_decrypt(&self, ciphertext: &[u8]) -> Result<(u64, Vec<u8>), CryptoError> {
        let next = self
            .receive_sequence
            .checked_add(1)
            .ok_or(CryptoError::InvalidKey)?;
        let plaintext = XSalsa20Poly1305::new(&self.key)
            .decrypt(Nonce::from_slice(&nonce(next)), ciphertext)
            .map_err(|_| CryptoError::DecryptionFailed)?;
        Ok((next, plaintext))
    }

    pub fn commit_receive(&mut self, sequence: u64) {
        self.receive_sequence = sequence;
    }
}

fn nonce(sequence: u64) -> [u8; 24] {
    let mut nonce = [0_u8; 24];
    nonce[..8].copy_from_slice(&sequence.to_le_bytes());
    nonce
}

pub fn verify_signature(
    public_key: &[u8],
    signature: &[u8],
    payload: &[u8],
) -> Result<(), CryptoError> {
    let key_bytes: [u8; 32] = public_key.try_into().map_err(|_| CryptoError::InvalidKey)?;
    let signature_bytes: [u8; 64] = signature
        .try_into()
        .map_err(|_| CryptoError::InvalidSignature)?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| CryptoError::InvalidKey)?;
    let signature = Signature::from_bytes(&signature_bytes);
    key.verify_strict(payload, &signature)
        .map_err(|_| CryptoError::InvalidSignature)
}

pub fn hash_password(password: &str, salt: &str, challenge: &str) -> [u8; 32] {
    let intermediate = Sha256::digest([password.as_bytes(), salt.as_bytes()].concat());
    let final_hash = Sha256::digest([intermediate.as_slice(), challenge.as_bytes()].concat());
    final_hash.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secretbox_round_trip_and_counter() {
        let mut sender = SecretBoxStream::new([3_u8; 32]);
        let mut receiver = SecretBoxStream::new([3_u8; 32]);
        let encrypted = sender.encrypt(b"private").unwrap();
        assert_eq!(receiver.decrypt(&encrypted).unwrap(), b"private");
        assert!(receiver.decrypt(&encrypted).is_err());
    }

    #[test]
    fn password_hash_is_stable() {
        assert_eq!(
            hex::encode(hash_password("pass", "salt", "challenge")),
            "4cbef6a35aa3cb9a54800f6b065074669e18dcf40024394a9f438fde86f4767a"
        );
    }
}
