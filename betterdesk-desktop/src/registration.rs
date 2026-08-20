//! RustDesk-compatible device registration lifecycle.
//!
//! RegisterPk is the persistence/enrollment entry point on BetterDesk signal.
//! In managed mode the server records the peer in its pending-enrollment
//! queue; in open mode it persists the peer immediately.

use std::{
    sync::{Mutex, OnceLock},
    thread,
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

use crate::{config, rustdesk_session::RustDeskSession};

static STATUS: OnceLock<Mutex<String>> = OnceLock::new();
static RUNNING: OnceLock<Mutex<bool>> = OnceLock::new();

fn status_slot() -> &'static Mutex<String> {
    STATUS.get_or_init(|| Mutex::new("idle".to_owned()))
}

fn running_slot() -> &'static Mutex<bool> {
    RUNNING.get_or_init(|| Mutex::new(false))
}

pub fn status() -> String {
    status_slot()
        .lock()
        .expect("registration status poisoned")
        .clone()
}

pub fn start(config_json: &str, device_id: &str, public_key: &str) -> bool {
    let Ok(mut running) = running_slot().lock() else {
        return false;
    };
    if *running {
        return false;
    }

    let parsed_config = match serde_json::from_str::<config::ServerConfig>(config_json) {
        Ok(value) => value,
        Err(error) => {
            set_status(format!("invalid_config:{error}"));
            return false;
        }
    };
    let public_key = match config::decode_public_key(public_key) {
        Ok(value) => value,
        Err(error) => {
            set_status(format!("invalid_identity:{error}"));
            return false;
        }
    };
    if device_id.trim().is_empty() {
        set_status("invalid_identity:empty_device_id".to_owned());
        return false;
    }

    *running = true;
    set_status("registering".to_owned());
    let device_id = device_id.to_owned();
    thread::spawn(move || {
        let result = register_blocking(&parsed_config, &device_id, &public_key);
        match result {
            Ok(keep_alive) => set_status(format!("registered:keep_alive={keep_alive}")),
            Err(error) => set_status(format!("failed:{}", error)),
        }
        if let Ok(mut running) = running_slot().lock() {
            *running = false;
        }
    });
    true
}

fn register_blocking(
    server_config: &config::ServerConfig,
    device_id: &str,
    public_key: &[u8],
) -> Result<i32> {
    let mut hasher = Sha256::new();
    hasher.update(public_key);
    let digest = hasher.finalize();
    let uuid = &digest[..16];
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create registration runtime")?;
    runtime.block_on(RustDeskSession::register_device(
        server_config,
        device_id,
        uuid,
        public_key,
    ))
}

pub fn public_key_from_json(value: &str) -> Result<String> {
    let public = config::decode_public_key(value)?;
    Ok(STANDARD.encode(public))
}

fn set_status(value: String) {
    if let Ok(mut status) = status_slot().lock() {
        *status = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_identity_is_derived_from_a_32_byte_public_key() {
        let value = public_key_from_json(&STANDARD.encode([7_u8; 32])).unwrap();
        assert_eq!(value, STANDARD.encode([7_u8; 32]));
    }
}
