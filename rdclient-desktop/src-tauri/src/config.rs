use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_config_version")]
    pub config_version: u32,
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub tls_strict: bool,
    #[serde(default)]
    pub discovered_via: Option<String>,
    #[serde(default)]
    pub ui_lang: Option<String>,
}

fn default_config_version() -> u32 {
    CONFIG_VERSION
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            config_version: CONFIG_VERSION,
            server_url: None,
            tls_strict: false,
            discovered_via: None,
            ui_lang: None,
        }
    }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

pub fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: AppConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cfg.config_version == 0 {
        cfg.config_version = CONFIG_VERSION;
    }
    Ok(cfg)
}

pub fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let mut to_save = cfg.clone();
    to_save.config_version = CONFIG_VERSION;
    let raw = serde_json::to_string_pretty(&to_save).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn clear_config(app: &AppHandle) -> Result<(), String> {
    let path = config_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read optional embedded installer config `{exe_dir}/betterdesk-rdclient.json`.
pub fn load_embedded_server_url() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("betterdesk-rdclient.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("server_url")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn env_server_url() -> Option<String> {
    std::env::var("BETTERDESK_SERVER_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn apply_tls_from_config(cfg: &AppConfig) {
    if cfg.tls_strict {
        // SAFETY: before any WebView/GTK init in setup().
        unsafe {
            std::env::set_var("BETTERDESK_TLS_STRICT", "1");
        }
    }
}
