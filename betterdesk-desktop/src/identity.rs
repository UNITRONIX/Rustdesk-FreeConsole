//! Persistent-device identity primitives.
//!
//! The durable secret is stored by the platform credential store. This module
//! only creates high-entropy values and deterministic display IDs; it never
//! writes identity material to a plaintext file.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::SigningKey;

const PASSWORD_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%";

pub fn generate_device_id() -> Result<String> {
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).context("generate device identity")?;
    let number = u64::from_le_bytes(random) % 900_000_000 + 100_000_000;
    Ok(number.to_string())
}

pub fn generate_rotating_password() -> Result<String> {
    let mut random = [0_u8; 20];
    getrandom::fill(&mut random).context("generate rotating password")?;
    let password = random
        .into_iter()
        .map(|value| PASSWORD_ALPHABET[usize::from(value) % PASSWORD_ALPHABET.len()] as char)
        .collect();
    Ok(password)
}

pub fn generate_keypair() -> Result<String> {
    let mut private = [0_u8; 32];
    getrandom::fill(&mut private).context("generate device identity key")?;
    let signing_key = SigningKey::from_bytes(&private);
    let public = signing_key.verifying_key().to_bytes();
    Ok(serde_json::json!({
        "private": STANDARD.encode(private),
        "public": STANDARD.encode(public),
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_numeric_and_server_compatible() {
        let id = generate_device_id().unwrap();
        assert_eq!(id.len(), 9);
        assert!(id.chars().all(|character| character.is_ascii_digit()));
    }

    #[test]
    fn rotating_password_has_sufficient_length() {
        let password = generate_rotating_password().unwrap();
        assert_eq!(password.chars().count(), 20);
    }

    #[test]
    fn keypair_is_exported_as_two_base64_secrets() {
        let value: serde_json::Value = serde_json::from_str(&generate_keypair().unwrap()).unwrap();
        assert_eq!(value["private"].as_str().unwrap().len(), 44);
        assert_eq!(value["public"].as_str().unwrap().len(), 44);
    }
}
