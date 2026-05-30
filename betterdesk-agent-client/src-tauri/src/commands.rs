use crate::cdap_client::CdapClient;
use crate::config::{AccessMode, AgentConfig};
use crate::registration;
use crate::sidecar::{SidecarConfig, SidecarStatus};
use crate::sysinfo_collect::SystemSnapshot;
use log::info;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// Shared application state managed by Tauri.
pub struct AgentState {
    pub config: Mutex<AgentConfig>,
    pub chat_history: Mutex<Vec<ChatMessage>>,
    /// Native CDAP WebSocket client kept for the lightweight telemetry path.
    /// The managed Go sidecar below is the active runtime for full remote
    /// desktop parity.
    pub cdap: CdapClient,
    /// Managed Go agent sidecar. This is the active runtime for remote desktop
    /// parity because it contains desktop streaming, input, monitor, and
    /// consent handlers that the native Rust CDAP client does not yet provide.
    pub sidecar: crate::sidecar::SidecarManager,
    /// Sessions currently being streamed to operators. Tracked here so the
    /// frontend can render the per-monitor overlay and "Disconnect" button
    /// without round-tripping to the sidecar.
    pub active_sessions: Mutex<Vec<ActiveSession>>,
}

/// Single inbound remote-desktop session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    pub session_id: String,
    pub operator: String,
    /// Reported by the Go sidecar's SESSION_START event: `supervised` or
    /// `unattended`.
    pub mode: String,
    /// ISO-8601 timestamp captured when the session became active.
    pub started_at: String,
}

/// Chat message structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub sender: String,
    pub sender_type: String, // "user" or "operator"
    pub content: String,
    pub timestamp: String,
}

/// Agent status returned to the frontend.
#[derive(Serialize)]
pub struct AgentStatus {
    pub registered: bool,
    pub connected: bool,
    pub device_id: String,
    pub device_name: String,
    pub server_address: String,
    pub hostname: String,
    pub platform: String,
    pub version: String,
    pub uptime: String,
    pub last_sync: String,
}

/// Settings struct for frontend read/write.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSettings {
    pub server_address: String,
    pub api_key: String,
    pub cdap_port: u16,
    pub allow_screen_capture: bool,
    pub require_consent: bool,
    /// Remote-desktop access policy. See [`AccessMode`].
    pub access_mode: AccessMode,
    pub allow_terminal: bool,
    pub allow_file_browser: bool,
    pub allow_clipboard: bool,
    pub auto_start_sidecar: bool,
    pub language: String,
    pub autostart: bool,
    pub start_minimized: bool,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredLanServer {
    pub name: String,
    pub version: String,
    pub address: String,
    pub port: u16,
    pub api_port: u16,
    pub protocol: String,
    pub console_url: String,
}

// ─────────────────────────── Status & Lifecycle ───────────────────────────

/// Returns true when the agent process runs with local OS administrator
/// privileges. Used by the frontend + tray menu to gate sensitive actions
/// (Settings, Quit agent, Unregister) so regular users cannot disable the
/// agent without elevation.
#[tauri::command]
pub fn is_os_admin() -> bool {
    let value = crate::privileges::is_os_admin();
    log::info!("IPC is_os_admin -> {}", value);
    value
}

/// Exits the agent process immediately.
/// Called from the overflow menu "Close agent" button or the quit dialog.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    // Stop background runtimes gracefully before exit.
    let state = app.state::<AgentState>();
    state.sidecar.stop();
    state.cdap.stop();
    app.exit(0);
}

/// Verify the current user's password via `sudo -S -v`.
///
/// Returns `true` when the password is accepted, `false` on wrong password.
/// Returns `Err` only when `sudo` itself is unavailable on the system.
///
/// The password is consumed once and never stored — it travels over the
/// secure Tauri IPC channel (same-process WebView ↔ Rust, never a network).
#[tauri::command]
pub async fn authenticate_sudo(password: String) -> Result<bool, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if password.is_empty() {
        return Ok(false);
    }

    let mut child = Command::new("sudo")
        .args(["-S", "-v"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("sudo not available: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        // Append newline — sudo -S reads a line from stdin.
        let _ = writeln!(stdin, "{}", password);
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.success())
}

/// Frontend -> Rust log bridge.
/// Stores important UI boot/runtime diagnostics in the normal agent logs so
/// packaged builds can be debugged without opening browser devtools.
#[tauri::command]
pub fn log_frontend_event(
    level: String,
    scope: String,
    message: String,
    data: Option<serde_json::Value>,
) {
    let suffix = data
        .map(|value| format!(" | data={}", value))
        .unwrap_or_default();

    match level.as_str() {
        "trace" => log::trace!("[frontend:{}] {}{}", scope, message, suffix),
        "debug" => log::debug!("[frontend:{}] {}{}", scope, message, suffix),
        "warn" => log::warn!("[frontend:{}] {}{}", scope, message, suffix),
        "error" => log::error!("[frontend:{}] {}{}", scope, message, suffix),
        _ => log::info!("[frontend:{}] {}{}", scope, message, suffix),
    }
}

#[tauri::command]
pub fn get_agent_status(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    // Fast path: only touch cached config. Avoid `SystemSnapshot::collect()`
    // here — it enumerates processes/disks/networks and can take several
    // seconds on Windows, which made the frontend spinner hang indefinitely.
    // Use `get_system_info` separately for slow telemetry.
    let config = state.config.lock().map_err(|e| e.to_string())?;

    // Cheap hostname lookup (single syscall) — still useful for the header.
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let status = AgentStatus {
        registered: config.is_registered(),
        connected: config.is_registered(), // simplified: registered = connected
        device_id: config.device_id.clone(),
        device_name: config.device_name.clone(),
        server_address: config.server_address.clone(),
        hostname,
        platform: format!(
            "{} ({})",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime: String::new(), // filled by `get_system_info` on demand
        last_sync: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string(),
    };

    log::info!(
        "IPC get_agent_status -> registered={}, device_id={:?}, server={:?}",
        status.registered,
        status.device_id,
        status.server_address
    );

    Ok(status)
}

/// Slow system telemetry — hostname, full OS version, CPU brand, RAM/disk totals,
/// uptime. Split from `get_agent_status` so the startup path stays fast.
#[tauri::command]
pub fn get_system_info() -> Result<serde_json::Value, String> {
    let snap = SystemSnapshot::collect();
    Ok(serde_json::json!({
        "hostname": snap.hostname,
        "os": snap.os,
        "os_version": snap.os_version,
        "arch": snap.arch,
        "cpu_name": snap.cpu_name,
        "cpu_cores": snap.cpu_cores,
        "total_memory_mb": snap.total_memory_mb,
        "total_disk_mb": snap.total_disk_mb,
        "username": snap.username,
        "uptime": format_uptime(),
        "platform": format!("{} {} ({})", snap.os, snap.os_version, snap.arch),
    }))
}

/// Returns the list of installed applications detected on this device.
/// May take several seconds on Windows (registry scan). Run in background.
#[tauri::command]
pub fn get_installed_software() -> Vec<crate::sysinfo_collect::InstalledApp> {
    crate::sysinfo_collect::collect_installed_software()
}

/// Returns running (and stopped) system services.
#[tauri::command]
pub fn get_system_services() -> Vec<crate::sysinfo_collect::SystemService> {
    crate::sysinfo_collect::collect_services()
}

/// Returns disk partition details.
#[tauri::command]
pub fn get_disk_partitions() -> Vec<crate::sysinfo_collect::DiskPartition> {
    crate::sysinfo_collect::collect_disk_partitions()
}

/// Returns network adapter information.
#[tauri::command]
pub fn get_network_adapters() -> Vec<crate::sysinfo_collect::NetworkAdapter> {
    crate::sysinfo_collect::collect_network_adapters()
}

#[tauri::command]
pub async fn reconnect_agent(state: State<'_, AgentState>) -> Result<String, String> {
    let (address, device_id) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered".to_string());
        }
        (config.server_address.clone(), config.device_id.clone())
    };

    let client = crate::registration::build_http_client(10).map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/heartbeat");
    let payload = serde_json::json!({ "id": device_id });

    client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Reconnect failed: {}", e))?;

    info!("Reconnect heartbeat sent for {}", device_id);
    Ok("Reconnected".to_string())
}

#[tauri::command]
pub async fn send_diagnostics(state: State<'_, AgentState>) -> Result<String, String> {
    let (address, device_id) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered".to_string());
        }
        (config.server_address.clone(), config.device_id.clone())
    };

    let sysinfo = SystemSnapshot::collect();

    let payload = serde_json::json!({
        "id": device_id,
        "hostname": sysinfo.hostname,
        "os": sysinfo.os,
        "version": sysinfo.os_version,
        "platform": format!("{} {}", sysinfo.os, sysinfo.arch),
        "cpu": sysinfo.cpu_name,
        "memory": format!("{} MB", sysinfo.total_memory_mb),
        "disk": format!("{} MB", sysinfo.total_disk_mb),
    });

    let client = crate::registration::build_http_client(10).map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/sysinfo");

    client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Diagnostics send failed: {}", e))?;

    info!("Diagnostics sent for {}", device_id);
    Ok("Diagnostics sent".to_string())
}

#[tauri::command]
pub fn get_agent_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Return the branding profile bundled with this build.  The frontend reads
/// it once on startup to apply company colors, product name, and contact
/// details set by the Console "Generator agenta".
#[tauri::command]
pub fn get_branding(app: tauri::AppHandle) -> crate::branding::Branding {
    crate::branding::load(&app)
}

#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    // Use Tauri's clipboard API via shell command fallback.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args(["-Command", &format!("Set-Clipboard -Value '{}'", text.replace('\'', "''"))])
            .output()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let mut child = std::process::Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .or_else(|_| {
                std::process::Command::new("xsel")
                    .args(["--clipboard", "--input"])
                    .stdin(std::process::Stdio::piped())
                    .spawn()
            })
            .map_err(|e| e.to_string())?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ─────────────────────────── Registration Flow ───────────────────────────

#[tauri::command]
pub async fn validate_server_step(
    address: String,
    step_key: String,
) -> Result<serde_json::Value, String> {
    let result = registration::validate_step(&address, &step_key).await;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

/// Register this device.  Returns `{ "status": "approved"|"pending", "device_id": "…" }`.
/// "pending" means the server is in managed-enrollment mode and an operator must
/// approve the device in the web console Registrations tab.  The frontend should
/// then poll via `poll_enrollment_status` until the status changes.
#[tauri::command]
pub async fn register_device(
    address: String,
    state: State<'_, AgentState>,
) -> Result<serde_json::Value, String> {
    // Clone config so MutexGuard is not held across await.
    let mut config_clone = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.server_address = address;
        config.clone()
    };

    let enrollment = registration::register_get_status(&mut config_clone)
        .await
        .map_err(|e| e.to_string())?;

    // Re-registration of a device that already exists on the server returns
    // `approved` but does NOT emit a fresh device_token (the server reuses the
    // existing one). If we lost the local copy (e.g. user reset agent-config),
    // recover it from the OS keyring before persisting state. Without this,
    // the post-registration sidecar auto-start fails with
    // "CDAP sidecar requires a valid API key … or a server-issued device token".
    if config_clone.registered
        && config_clone.auth_token.is_empty()
        && config_clone.api_key.is_empty()
        && !config_clone.device_id.is_empty()
    {
        if let Some(stored) = crate::config::AgentConfig::load_token_secure(&config_clone.device_id) {
            info!("Recovered auth token from OS keyring for {}", config_clone.device_id);
            config_clone.auth_token = stored;
        }
    }

    // Apply mutations back to shared state (pending saves partial state too).
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        *config = config_clone.clone();
        if config_clone.registered {
            if let Err(e) = config.store_token_secure() {
                info!("Keyring store skipped: {}", e);
            }
        }
    }

    // On immediate approval, fire a heartbeat so the device shows as ONLINE
    // without waiting for the 12-second background tick.
    if enrollment.status == "approved" {
        let hb_url = format_api_url(&config_clone.server_address, "/heartbeat");
        let hb_payload = serde_json::json!({ "id": enrollment.device_id });
        if let Ok(client) = registration::build_http_client(8) {
            let _ = client.post(&hb_url).json(&hb_payload).send().await;
        }
    }

    Ok(serde_json::json!({
        "status":    enrollment.status,
        "device_id": enrollment.device_id,
        "message":   enrollment.message,
    }))
}

/// Poll the server for the current enrollment status of a pending device.
/// Returns `{ "status": "approved"|"pending"|"rejected", "device_id": "…", "message": "…" }`.
/// When status becomes "approved", the frontend finalises config and proceeds to the sync step.
#[tauri::command]
pub async fn poll_enrollment_status(
    address: String,
    device_id: String,
    state: State<'_, AgentState>,
) -> Result<serde_json::Value, String> {
    let enrollment = registration::poll_enrollment_status(&address, &device_id)
        .await
        .map_err(|e| e.to_string())?;

    // On approval: mark device as registered in shared config.
    if enrollment.status == "approved" {
        {
            let mut config = state.config.lock().map_err(|e| e.to_string())?;
            config.registered = true;
            config.device_id = enrollment.device_id.clone();
            // If neither api_key nor auth_token is set (server did not emit a
            // fresh device_token on re-approval), recover from OS keyring.
            if config.auth_token.is_empty() && config.api_key.is_empty() {
                if let Some(stored) = crate::config::AgentConfig::load_token_secure(&config.device_id) {
                    info!("Recovered auth token from OS keyring for {}", config.device_id);
                    config.auth_token = stored;
                }
            }
            if let Err(e) = config.save() {
                info!("Config save after approval: {}", e);
            }
            if let Err(e) = config.store_token_secure() {
                info!("Keyring store skipped: {}", e);
            }
        }

        // Immediate heartbeat so the device shows as ONLINE right away.
        let hb_url = format_api_url(&address, "/heartbeat");
        let hb_payload = serde_json::json!({ "id": enrollment.device_id });
        if let Ok(client) = registration::build_http_client(8) {
            let _ = client.post(&hb_url).json(&hb_payload).send().await;
        }
    }

    Ok(serde_json::json!({
        "status":    enrollment.status,
        "device_id": enrollment.device_id,
        "message":   enrollment.message,
    }))
}

#[tauri::command]
pub async fn sync_initial_config(
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    registration::sync_config(&config)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-start the managed CDAP sidecar once the wizard completes. The boot
    // path in lib.rs only fires when `is_registered` is already true at app
    // launch — for first-run registration we have to kick the sidecar here
    // (skipping the OS-admin gate, which only protects the user-facing IPC
    // command from being invoked while the sidecar runs).
    if config.is_registered() && config.auto_start_sidecar {
        match build_sidecar_config(&state).await {
            Ok(sidecar_cfg) => {
                state.sidecar.stop();
                if let Err(e) = state.sidecar.start(&sidecar_cfg, app) {
                    log::warn!("[sidecar] Post-registration auto-start failed: {}", e);
                } else {
                    info!("[sidecar] Auto-started after initial registration");
                }
            }
            Err(e) => log::warn!("[sidecar] Skipping post-registration start: {}", e),
        }
    }

    Ok(())
}

// ─────────────────────────── Chat ───────────────────────────

#[tauri::command]
pub fn get_chat_history(state: State<'_, AgentState>) -> Result<Vec<ChatMessage>, String> {
    let history = state.chat_history.lock().map_err(|e| e.to_string())?;
    Ok(history.clone())
}

#[tauri::command]
pub async fn send_chat_message(
    message: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let (msg, address, device_id) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered".to_string());
        }
        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            sender: config.device_name.clone(),
            sender_type: "user".to_string(),
            content: message.clone(),
            timestamp: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        };
        (msg, config.server_address.clone(), config.device_id.clone())
    };

    // Store locally first.
    {
        let mut history = state.chat_history.lock().map_err(|e| e.to_string())?;
        history.push(msg.clone());
        if history.len() > 200 {
            let drain_count = history.len() - 200;
            history.drain(..drain_count);
        }
    }

    // Deliver to the web console relay (port 5000) — best-effort.
    let payload = serde_json::json!({
        "device_id": device_id,
        "sender":    msg.sender,
        "content":   message,
        "timestamp": msg.timestamp,
    });

    let url = format_console_url(&address, "/bd/chat/send");
    if let Ok(client) = crate::registration::build_http_client(8) {
        if let Err(e) = client.post(&url).json(&payload).send().await {
            info!("Chat delivery failed (non-fatal): {}", e);
        }
    }

    Ok(())
}

// ─────────────────────────── Help Request ───────────────────────────

#[tauri::command]
pub async fn request_help(
    description: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let (address, device_id, device_name) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered".to_string());
        }
        (config.server_address.clone(), config.device_id.clone(), config.device_name.clone())
    };

    let payload = serde_json::json!({
        "device_id": device_id,
        "device_name": device_name,
        "description": description,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let client = crate::registration::build_http_client(10).map_err(|e| e.to_string())?;

    let url = format_console_url(&address, "/bd/help-request");

    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Help request failed: {}", e))?;

    if resp.status().is_success() {
        info!("Help request sent from {}", device_id);
        Ok(())
    } else {
        Err(format!("Server returned {}", resp.status()))
    }
}

#[tauri::command]
pub async fn cancel_help_request(state: State<'_, AgentState>) -> Result<(), String> {
    let (address, device_id) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered".to_string());
        }
        (config.server_address.clone(), config.device_id.clone())
    };

    let payload = serde_json::json!({
        "device_id": device_id,
        "action": "cancel",
    });

    let client = crate::registration::build_http_client(10).map_err(|e| e.to_string())?;

    let url = format_console_url(&address, "/bd/help-request");

    let _ = client.delete(&url).json(&payload).send().await;
    info!("Help request cancelled for {}", device_id);
    Ok(())
}

// ─────────────────────────── Settings ───────────────────────────

#[tauri::command]
pub fn get_agent_settings(state: State<'_, AgentState>) -> Result<AgentSettings, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(AgentSettings {
        server_address: config.server_address.clone(),
        api_key: config.api_key.clone(),
        cdap_port: config.cdap_port,
        allow_screen_capture: config.allow_screen_capture,
        require_consent: config.require_consent,
        access_mode: config.access_mode,
        allow_terminal: config.allow_terminal,
        allow_file_browser: config.allow_file_browser,
        allow_clipboard: config.allow_clipboard,
        auto_start_sidecar: config.auto_start_sidecar,
        language: config.language.clone(),
        autostart: config.autostart,
        start_minimized: config.start_minimized,
    })
}

#[tauri::command]
pub fn save_agent_settings(
    settings: AgentSettings,
    state: State<'_, AgentState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let autostart_desired = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;

        config.server_address = settings.server_address;
        config.api_key = settings.api_key;
        config.cdap_port = settings.cdap_port;
        config.allow_screen_capture = settings.allow_screen_capture;
        // `access_mode` is authoritative; `require_consent` is kept in sync
        // afterwards so legacy code paths still see a consistent value.
        config.access_mode = settings.access_mode;
        config.require_consent = settings.require_consent;
        config.sync_access_mode();
        config.allow_terminal = settings.allow_terminal;
        config.allow_file_browser = settings.allow_file_browser;
        config.allow_clipboard = settings.allow_clipboard;
        config.auto_start_sidecar = settings.auto_start_sidecar;
        config.language = settings.language;
        config.autostart = settings.autostart;
        config.start_minimized = settings.start_minimized;

        config.save().map_err(|e| e.to_string())?;
        config.autostart
    };

    // Sync OS-level autostart registration (Linux .desktop, Windows HKCU Run,
    // macOS LaunchAgent) with the persisted preference.
    crate::autostart::sync_os_autostart(&app, autostart_desired);

    info!("Settings saved (autostart={})", autostart_desired);
    Ok(())
}

#[tauri::command]
pub async fn test_server_connection(address: String) -> Result<String, String> {
    let result = registration::validate_step(&address, "availability").await;

    if result.success {
        Ok("Connection successful".to_string())
    } else {
        Err(result.message)
    }
}

#[tauri::command]
pub async fn discover_lan_servers() -> Result<Vec<DiscoveredLanServer>, String> {
    let discovered = registration::discover_lan_servers().await.map_err(|e| e.to_string())?;
    Ok(discovered
        .into_iter()
        .map(|server| DiscoveredLanServer {
            name: server.name,
            version: server.version,
            address: server.address,
            port: server.port,
            api_port: server.api_port,
            protocol: server.protocol,
            console_url: server.console_url,
        })
        .collect())
}

// ─────────────────────────── CDAP client control ───────────────────────────

async fn build_sidecar_config(state: &AgentState) -> Result<SidecarConfig, String> {
    let mut config = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.is_registered() {
            return Err("Device not registered — complete setup first".to_string());
        }
        config.clone()
    };

    let original_address = config.server_address.clone();
    registration::normalize_server_origin_best_effort(&mut config).await;

    if config.server_address != original_address {
        let mut shared = state.config.lock().map_err(|e| e.to_string())?;
        shared.server_address = config.server_address.clone();
    }

    Ok(config.to_sidecar_config())
}

/// Returns the current status of the managed Go CDAP sidecar.
#[tauri::command]
pub fn get_sidecar_status(state: State<'_, AgentState>) -> SidecarStatus {
    state.sidecar.status()
}

/// Start or restart the managed Go CDAP sidecar.
#[tauri::command]
pub async fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<SidecarStatus, String> {
    if !crate::privileges::is_os_admin() {
        return Err("Administrator privileges are required to control the CDAP agent".to_string());
    }

    let sidecar_cfg = build_sidecar_config(&state).await?;
    state.sidecar.stop();
    state
        .sidecar
        .start(&sidecar_cfg, app)
        .map_err(|e| e.to_string())?;
    info!("CDAP sidecar started via IPC command");
    Ok(state.sidecar.status())
}

/// Stop the CDAP client.
#[tauri::command]
pub fn stop_sidecar(state: State<'_, AgentState>) -> Result<SidecarStatus, String> {
    if !crate::privileges::is_os_admin() {
        return Err("Administrator privileges are required to stop the CDAP agent".to_string());
    }

    state.sidecar.stop();
    info!("CDAP sidecar stopped via IPC command");
    Ok(state.sidecar.status())
}

/// Restart the CDAP client (re-reads current config).
#[tauri::command]
pub async fn restart_sidecar(
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<SidecarStatus, String> {
    start_sidecar(app, state).await
}

/// Legacy command — redirects to CDAP restart.
#[tauri::command]
pub async fn restart_agent_service(
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    start_sidecar(app, state).await.map(|_| ())
}

/// Forward a supervised-session consent response to the Go sidecar.
#[tauri::command]
pub fn answer_consent(
    state: State<'_, AgentState>,
    session_id: String,
    granted: bool,
) -> Result<(), String> {
    state.sidecar.send_consent(&session_id, granted);
    Ok(())
}

#[tauri::command]
pub fn unregister_device(state: State<'_, AgentState>) -> Result<(), String> {
    state.sidecar.stop();
    state.cdap.stop();

    let mut config = state.config.lock().map_err(|e| e.to_string())?;

    let old_id = config.device_id.clone();

    // Clear credentials from OS keyring.
    AgentConfig::clear_token_secure(&old_id);

    // Reset config to defaults.
    *config = AgentConfig::default();
    config.save().map_err(|e| e.to_string())?;

    info!("Device {} unregistered — config reset", old_id);
    Ok(())
}

// ─────────────────────────── Helpers ───────────────────────────

/// Format API URL from server address and path (targets Go server port 21114).
fn format_api_url(address: &str, path: &str) -> String {
    let addr = address.trim();
    let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };

    if let Ok(parsed) = url::Url::parse(&with_scheme) {
        let host = parsed.host_str().unwrap_or("localhost");
        let port = parsed.port().unwrap_or(21114);
        let scheme = parsed.scheme();
        format!("{}://{}:{}/api{}", scheme, host, port, path)
    } else {
        format!("http://{}:21114/api{}", addr, path)
    }
}

/// Format a web console URL from server address and path (targets port 5000).
/// Help-request and chat endpoints live on the Node.js console, not the Go API.
fn format_console_url(address: &str, path: &str) -> String {
    let addr = address.trim();
    let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };

    if let Ok(parsed) = url::Url::parse(&with_scheme) {
        let host = parsed.host_str().unwrap_or("localhost");
        let scheme = parsed.scheme();
        format!("{}://{}:5000/api{}", scheme, host, path)
    } else {
        format!("http://{}:5000/api{}", addr, path)
    }
}

/// Format system uptime as human-readable string.
fn format_uptime() -> String {
    let uptime_secs = sysinfo::System::uptime();
    let days = uptime_secs / 86400;
    let hours = (uptime_secs % 86400) / 3600;
    let minutes = (uptime_secs % 3600) / 60;

    if days > 0 {
        format!("{}d {}h {}m", days, hours, minutes)
    } else if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    }
}

// ---------------------------------------------------------------------------
// Access-mode controls (Phase 1: supervised / unattended / disabled)
// ---------------------------------------------------------------------------

/// Returns the currently configured remote-desktop access mode.
#[tauri::command]
pub fn get_access_mode(state: State<AgentState>) -> Result<AccessMode, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.access_mode)
}

/// Updates the access mode, persists the config, and restarts the sidecar so
/// the new policy is pushed into the Go agent's runtime config immediately.
#[tauri::command]
pub async fn set_access_mode(
    mode: AccessMode,
    state: State<'_, AgentState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sidecar_cfg = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        if config.access_mode == mode {
            return Ok(());
        }
        config.access_mode = mode;
        config.sync_access_mode();
        config.save().map_err(|e| e.to_string())?;
        config.to_sidecar_config()
    };

    // Hot-apply: restart the sidecar so the Go agent picks up the new policy.
    // We ignore errors here — the next sidecar start will use the new config
    // regardless, and the access mode is already persisted to disk.
    state.sidecar.stop();
    if let Err(e) = state.sidecar.start(&sidecar_cfg, app.clone()) {
        log::warn!("[access-mode] Sidecar restart failed: {}", e);
    }

    let _ = app.emit("access-mode-changed", mode);
    Ok(())
}

/// Returns the list of remote-desktop sessions currently being streamed.
#[tauri::command]
pub fn get_active_sessions(state: State<AgentState>) -> Result<Vec<ActiveSession>, String> {
    let sessions = state.active_sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.clone())
}

/// Internal helper invoked by the sidecar stdout reader to record a session.
pub fn record_session_start(state: &AgentState, session: ActiveSession) {
    if let Ok(mut sessions) = state.active_sessions.lock() {
        // Replace any stale entry with the same session id.
        sessions.retain(|s| s.session_id != session.session_id);
        sessions.push(session);
    }
}

/// Internal helper invoked by the sidecar stdout reader to drop a session.
pub fn record_session_end(state: &AgentState, session_id: &str) {
    if let Ok(mut sessions) = state.active_sessions.lock() {
        sessions.retain(|s| s.session_id != session_id);
    }
}

/// Requests the sidecar to terminate the given remote-desktop session.
/// This is intended for the "Disconnect" button on the on-screen overlay.
#[tauri::command]
pub async fn disconnect_active_session(
    session_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    record_session_end(&state, &session_id);
    state.sidecar.send_disconnect(&session_id);
    Ok(())
}
