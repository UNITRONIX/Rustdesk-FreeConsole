//! Push local access policy (mode + unattended password) to the BetterDesk server.

use anyhow::{anyhow, Result};
use log::{debug, warn};
use serde_json::json;

use crate::config::{AccessMode, AgentConfig};
use crate::registration;
use crate::tls;

pub async fn sync_access_policy(config: &AgentConfig) -> Result<()> {
    if !config.registered || config.device_id.is_empty() {
        return Err(anyhow!("device not registered"));
    }
    let token = config.auth_token.trim();
    if token.is_empty() {
        return Err(anyhow!("device token missing"));
    }

    let api_url = registration::resolve_api_base_url(&config.server_address).await?;
    let url = format!("{}/devices/self/access-policy", api_url.trim_end_matches('/'));

    let payload = json!({
        "device_id": config.device_id,
        "device_token": token,
        "password": config.unattended_password,
        "unattended_enabled": config.access_mode == AccessMode::Unattended,
    });

    let client = tls::build_http_client(15).map_err(|e| anyhow!(e))?;
    let resp = client.post(&url).json(&payload).send().await?;
    let code = resp.status();
    if code.is_success() || code.as_u16() == 204 {
        debug!("[policy-sync] access policy pushed for {}", config.device_id);
        return Ok(());
    }
    warn!("[policy-sync] server returned HTTP {}", code);
    Err(anyhow!("access policy sync failed (HTTP {})", code))
}
