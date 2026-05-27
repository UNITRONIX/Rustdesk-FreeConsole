use anyhow::Result;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Remote-desktop access policy enforced by the agent.
///
/// `Supervised` (default) shows a consent dialog before every session.
/// `Unattended`  starts sessions immediately without prompting the user.
/// `Disabled`    rejects every inbound desktop session locally; the operator
///               sees a clear "remote desktop disabled by user policy" error.
///
/// The legacy `require_consent` boolean is derived from this value at config
/// load and write time to keep wire compatibility with the Go sidecar's JSON
/// config until the sidecar gains a native `access_mode` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Supervised,
    Unattended,
    Disabled,
}

impl Default for AccessMode {
    fn default() -> Self {
        AccessMode::Supervised
    }
}

impl AccessMode {
    /// Whether the agent should prompt the user before starting a session.
    pub fn requires_consent(self) -> bool {
        matches!(self, AccessMode::Supervised)
    }

    /// Whether the agent should refuse desktop sessions outright.
    pub fn is_disabled(self) -> bool {
        matches!(self, AccessMode::Disabled)
    }
}

fn default_access_mode() -> AccessMode {
    AccessMode::Supervised
}

/// Persistent agent configuration stored as JSON on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    // ── Server connection ───────────────────────────────────────────────────

    /// Server address entered by the user.
    ///
    /// Normalized registrations persist a full origin such as
    /// "https://betterdesk.example.com:5443" so follow-up API/CDAP calls can
    /// preserve the correct transport scheme.
    pub server_address: String,

    /// API key used to authenticate the sidecar Go agent with the CDAP gateway.
    /// Obtained from the BetterDesk admin panel → API Keys.
    #[serde(default)]
    pub api_key: String,

    /// CDAP WebSocket port (default 21122).
    #[serde(default = "default_cdap_port")]
    pub cdap_port: u16,

    // ── Device identity ─────────────────────────────────────────────────────

    /// Unique device identifier assigned during registration.
    pub device_id: String,

    /// Device display name (defaults to hostname).
    pub device_name: String,

    /// Optional server-issued device token for CDAP authentication.
    /// Empty for the current enrollment flow unless the server explicitly
    /// returns such a token.
    pub auth_token: String,

    /// Whether the device has completed registration.
    pub registered: bool,

    // ── Capability gates ────────────────────────────────────────────────────
    // These control what the operator can do remotely. The user can change
    // them from the Settings panel. They are forwarded to the Go sidecar via
    // the go-agent-config.json file.

    /// Allow operators to view and control the screen (remote desktop).
    /// Maps to `screenshot` in Go agent config (current JPEG mode).
    #[serde(default = "default_true")]
    pub allow_screen_capture: bool,

    /// Remote-desktop access policy. New in 2026-05.
    ///
    /// Backward compatible: configs written by older builds only have
    /// `require_consent`; the loader migrates that into `access_mode` and the
    /// `require_consent` setter mirrors changes back to keep the sidecar
    /// JSON unchanged until it learns the new field.
    #[serde(default = "default_access_mode")]
    pub access_mode: AccessMode,

    /// Require explicit user consent dialog before a remote session starts.
    ///
    /// Treated as a derived mirror of `access_mode == Supervised`. Kept as a
    /// separate field so the Go sidecar JSON contract is unchanged and so
    /// old configs continue to load without losing user intent.
    #[serde(default = "default_true")]
    pub require_consent: bool,

    /// Allow operators to open a terminal on this device.
    #[serde(default = "default_true")]
    pub allow_terminal: bool,

    /// Allow operators to browse and transfer files.
    #[serde(default = "default_true")]
    pub allow_file_browser: bool,

    /// Allow clipboard sync between operator and this device.
    #[serde(default = "default_true")]
    pub allow_clipboard: bool,

    // ── Sidecar auto-start ──────────────────────────────────────────────────

    /// Start the Go sidecar agent automatically when Tauri app starts.
    /// Disable only for debugging — without the sidecar the device is invisible
    /// to operators (no CDAP connection, no screen sharing, no terminal).
    #[serde(default = "default_true")]
    pub auto_start_sidecar: bool,

    // ── General preferences ─────────────────────────────────────────────────

    /// Start Tauri app on system boot.
    pub autostart: bool,

    /// Minimize to system tray on startup (recommended — agent runs in background).
    pub start_minimized: bool,

    /// UI language code ("en" or "pl").
    pub language: String,
}

fn default_cdap_port() -> u16 { 21122 }
fn default_true() -> bool { true }

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_address: String::new(),
            api_key: String::new(),
            cdap_port: 21122,
            device_id: String::new(),
            device_name: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            auth_token: String::new(),
            registered: false,
            allow_screen_capture: true,
            access_mode: AccessMode::Supervised,
            require_consent: true,
            allow_terminal: true,
            allow_file_browser: true,
            allow_clipboard: true,
            auto_start_sidecar: true,
            autostart: true,
            start_minimized: true,
            language: "en".to_string(),
        }
    }
}

impl AgentConfig {
    /// Configuration file path.
    fn config_path() -> PathBuf {
        let dir = directories::ProjectDirs::from("com", "betterdesk", "agent")
            .map(|d| d.config_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        dir.join("agent-config.json")
    }

    /// Load config from disk. Returns default if file doesn't exist.
    pub fn load() -> Result<Self> {
        let path = Self::config_path();
        if !path.exists() {
            info!("No config file at {:?} — using defaults", path);
            return Ok(Self::default());
        }

        let content = std::fs::read_to_string(&path)?;
        // Detect legacy configs that lack `access_mode` so we can derive it
        // from the older `require_consent` field. serde_json::Value gives us a
        // cheap way to inspect the raw JSON before strongly typing it.
        let had_access_mode = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("access_mode").cloned())
            .is_some();

        let mut config: Self = serde_json::from_str(&content)?;
        if !had_access_mode {
            config.access_mode = if config.require_consent {
                AccessMode::Supervised
            } else {
                AccessMode::Unattended
            };
            info!(
                "Migrated legacy config to access_mode={:?} (from require_consent={})",
                config.access_mode, config.require_consent
            );
        }
        // Always keep require_consent in sync with access_mode so the sidecar
        // JSON written next reflects the new policy correctly.
        config.sync_access_mode();
        Ok(config)
    }

    /// Mirror `access_mode` into the derived `require_consent` field. Call
    /// after every mutation of `access_mode` so the sidecar JSON written next
    /// reflects user intent.
    pub fn sync_access_mode(&mut self) {
        self.require_consent = self.access_mode.requires_consent();
    }

    /// Repair stale configs produced by the legacy fake-registration flow.
    ///
    /// Older clients marked the device as registered after a heartbeat ACK and
    /// minted a local placeholder token (`BD-TOKEN-*`). That state is invalid:
    /// no peer exists on the server and the sidecar cannot authenticate.
    pub fn repair_legacy_registration_state(&mut self) -> Result<bool> {
        if self.registered && self.api_key.is_empty() && self.auth_token.starts_with("BD-TOKEN-") {
            warn!(
                "Detected legacy placeholder registration token for {:?}; resetting local enrollment state",
                self.device_id
            );

            let old_device_id = self.device_id.clone();
            self.registered = false;
            self.device_id.clear();
            self.auth_token.clear();

            if !old_device_id.is_empty() {
                Self::clear_token_secure(&old_device_id);
            }

            self.save()?;
            return Ok(true);
        }

        Ok(false)
    }

    /// Persist config to disk.
    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
        info!("Config saved to {:?}", path);
        Ok(())
    }

    /// Whether this device has completed registration with a server.
    pub fn is_registered(&self) -> bool {
        self.registered && !self.device_id.is_empty() && !self.server_address.is_empty()
    }

    /// Build a `CdapConfig` for the native CDAP client.
    pub fn to_cdap_config(&self) -> crate::cdap_client::CdapConfig {
        let data_dir = directories::ProjectDirs::from("com", "betterdesk", "agent")
            .map(|d| d.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        crate::cdap_client::CdapConfig {
            server_address: self.server_address.clone(),
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            api_key: self.api_key.clone(),
            auth_token: if self.auth_token.is_empty() {
                None
            } else {
                Some(self.auth_token.clone())
            },
            allow_terminal: self.allow_terminal,
            allow_file_browser: self.allow_file_browser,
            allow_clipboard: self.allow_clipboard,
            allow_screen_capture: self.allow_screen_capture,
            data_dir,
            cdap_port: self.cdap_port,
        }
    }

    /// Build a `SidecarConfig` for the bundled Go agent runtime.
    pub fn to_sidecar_config(&self) -> crate::sidecar::SidecarConfig {
        let data_dir = directories::ProjectDirs::from("com", "betterdesk", "agent")
            .map(|d| d.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        // When the policy is Disabled we force `allow_screen_capture=false`
        // on the wire so the Go sidecar refuses `desktop_start` outright,
        // even if the user toggled the capability gate on. The Tauri layer
        // also enforces this, but two-layer defense keeps the contract honest
        // if the sidecar config file is read directly.
        let screen_capture = self.allow_screen_capture && !self.access_mode.is_disabled();

        crate::sidecar::SidecarConfig {
            server_address: self.server_address.clone(),
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            api_key: self.api_key.clone(),
            auth_token: self.auth_token.clone(),
            allow_terminal: self.allow_terminal,
            allow_file_browser: self.allow_file_browser,
            allow_clipboard: self.allow_clipboard,
            allow_screen_capture: screen_capture,
            require_consent: self.access_mode.requires_consent(),
            data_dir,
            cdap_port: self.cdap_port,
        }
    }

    /// Store credentials securely via OS keyring.
    pub fn store_token_secure(&self) -> Result<()> {
        if self.auth_token.is_empty() {
            return Ok(());
        }
        let entry = keyring::Entry::new("betterdesk-agent", &self.device_id)?;
        entry.set_password(&self.auth_token)?;
        info!("Auth token stored in OS keyring");
        Ok(())
    }

    /// Retrieve token from OS keyring.
    pub fn load_token_secure(device_id: &str) -> Option<String> {
        keyring::Entry::new("betterdesk-agent", device_id)
            .ok()
            .and_then(|e| e.get_password().ok())
    }

    /// Delete token from OS keyring.
    pub fn clear_token_secure(device_id: &str) {
        if let Ok(entry) = keyring::Entry::new("betterdesk-agent", device_id) {
            let _ = entry.delete_credential();
        }
    }
}
