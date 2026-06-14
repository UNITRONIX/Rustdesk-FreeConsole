mod config;

#[cfg(target_os = "linux")]
pub mod linux_display;
pub mod tls_policy;

use config::{load_config, save_config};
use tls_policy::apply_window_builder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
const MAIN_LABEL: &str = "main";

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Server URL is required".into());
    }
    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("Invalid server URL".into());
    }

    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let parsed = url::parse_helper(&with_scheme)?;
    Ok(parsed)
}

mod url {
    pub fn parse_helper(input: &str) -> Result<String, String> {
        // Minimal validation without extra dependency — use tauri Url if available
        use std::str::FromStr;
        match tauri::Url::from_str(input) {
            Ok(url) => {
                let scheme = url.scheme();
                if scheme != "http" && scheme != "https" {
                    return Err("URL must use http or https".into());
                }
                let host = url.host_str().ok_or("URL must include a host")?;
                if host.is_empty() {
                    return Err("URL must include a host".into());
                }
                let mut base = format!("{}://{}", scheme, host);
                if let Some(port) = url.port() {
                    base = format!("{}://{}:{}", scheme, host, port);
                }
                Ok(base)
            }
            Err(_) => Err("Invalid server URL".into()),
        }
    }
}

fn is_valid_device_id(device_id: &str) -> bool {
    let len = device_id.len();
    if len < 3 || len > 64 {
        return false;
    }
    device_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn session_label(device_id: &str) -> String {
    format!("session-{}", device_id)
}

fn dashboard_url(base: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(&format!("{}/remote", base.trim_end_matches('/')))
        .map_err(|_| "Failed to build dashboard URL".to_string())
}

fn session_url(base: &str, device_id: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(&format!(
        "{}/remote/{}",
        base.trim_end_matches('/'),
        device_id
    ))
    .map_err(|_| "Failed to build session URL".to_string())
}

fn open_main_window(app: &AppHandle, url: WebviewUrl) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(MAIN_LABEL) {
        if let WebviewUrl::External(parsed) = url {
            existing
                .navigate(parsed)
                .map_err(|e| e.to_string())?;
            existing
                .set_focus()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        existing.close().map_err(|e| e.to_string())?;
    }

    apply_window_builder(
        WebviewWindowBuilder::new(app, MAIN_LABEL, url)
            .title("BetterDesk RdClient")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .center(),
    )
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn launch_main(app: &AppHandle) -> Result<(), String> {
    let cfg = load_config(app)?;
    let url = if let Some(base) = cfg.server_url {
        WebviewUrl::External(dashboard_url(&base)?)
    } else {
        WebviewUrl::App("setup.html".into())
    };
    open_main_window(app, url)
}

#[tauri::command]
fn get_server_url(app: AppHandle) -> Result<Option<String>, String> {
    Ok(load_config(&app)?.server_url)
}

#[tauri::command]
fn set_server_url(app: AppHandle, url: String) -> Result<(), String> {
    let normalized = normalize_server_url(&url)?;
    let mut cfg = load_config(&app)?;
    cfg.server_url = Some(normalized.clone());
    save_config(&app, &cfg)?;
    open_main_window(
        &app,
        WebviewUrl::External(dashboard_url(&normalized)?),
    )
}

#[tauri::command]
fn open_session(app: AppHandle, device_id: String, device_name: Option<String>) -> Result<(), String> {
    let device_id = device_id.trim().to_string();
    if !is_valid_device_id(&device_id) {
        return Err("Invalid device ID".into());
    }

    let cfg = load_config(&app)?;
    let base = cfg
        .server_url
        .ok_or("Server URL is not configured. Complete setup first.")?;

    let label = session_label(&device_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let title = device_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| device_id.clone());

    apply_window_builder(
        WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::External(session_url(&base, &device_id)?),
        )
        .title(format!("Remote — {title}"))
        .inner_size(1280.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .center(),
    )
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tls_policy::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_server_url,
            open_session
        ])
        .setup(|app| {
            launch_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BetterDesk RdClient");
}
