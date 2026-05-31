//! Sidecar manager — runs `betterdesk-agent` (Go binary) as a managed child
//! process inside the Tauri app.
//!
//! Architecture rationale
//! ─────────────────────
//! The Tauri app handles: device registration, config persistence, OS tray,
//! user-visible UI, privilege gating, and user consent dialogs.
//!
//! The Go sidecar handles: CDAP WebSocket connection to the server, heartbeat,
//! telemetry, terminal (PTY), file browser, clipboard sync, and screenshot
//! capture. This avoids a 4-6 week Rust rewrite of already-working Go code.
//!
//! Lifecycle
//! ─────────
//! 1. `SidecarManager::start()` writes a Go-format JSON config to the app data
//!    dir and spawns `betterdesk-agent -config <path>`.
//! 2. A monitor task (tokio::spawn) polls the child every 5 s. On exit it
//!    increments `restart_count`, applies exponential backoff (5 s × 2^n, max
//!    5 min), then restarts.
//! 3. `stop()` sends SIGTERM on Unix / TerminateProcess on Windows and waits up
//!    to 5 s for graceful shutdown before force-killing.
//! 4. `drop(SidecarManager)` stops the child automatically.
//!
//! Binary discovery
//! ────────────────
//! The binary is searched in this order:
//!   1. `$BETTERDESK_AGENT_BIN` env var (developer override).
//!   2. Same directory as the Tauri executable
//!      (`<exe-dir>/betterdesk-agent[.exe]`).
//!   3. App data dir (`<data>/betterdesk-agent[.exe]`).
//!   4. System PATH (allows system-installed agent to be managed by Tauri).

use anyhow::{anyhow, Context, Result};
use log::{debug, error, info, warn};
use serde::Serialize;
use std::{
    io::Write,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{async_runtime, Emitter, Manager};

// ── Public status ─────────────────────────────────────────────────────────

/// Snapshot of the sidecar process state, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    /// True when the Go agent process is alive.
    pub running: bool,
    /// PID of the child process, or 0 if not running.
    pub pid: u32,
    /// Number of automatic restarts since app launch.
    pub restart_count: u32,
    /// Human-readable state string for the UI.
    pub state: String,
    /// Path to the binary actually being used.
    pub binary_path: String,
    /// CDAP WebSocket URL the agent connects to.
    pub cdap_url: String,
}

// ── Go agent JSON config ──────────────────────────────────────────────────

/// JSON config written to disk for the Go agent binary.
/// Fields match `betterdesk-agent/agent/config.go`.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct GoAgentConfig {
    server: String,      // ws://host:21122/cdap
    auth_method: String, // api_key | device_token | user_password
    #[serde(skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    device_token: String,
    device_id: String,
    device_name: String,
    device_type: String, // os_agent | desktop | custom
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,

    terminal: bool,
    file_browser: bool,
    clipboard: bool,
    screenshot: bool,
    require_consent: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    video_codec: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    hw_accel: String,

    heartbeat_sec: u32,
    reconnect_sec: u32,
    max_reconnect: u32,
    log_level: String,
    data_dir: String,
}

// ── Public config mirror from Tauri AgentConfig ───────────────────────────

/// Subset of `AgentConfig` needed to generate the Go agent config.
/// Passed to `SidecarManager::start()`.
pub struct SidecarConfig {
    pub server_address: String, // "host:21114" or "host"
    pub device_id: String,
    pub device_name: String,
    pub api_key: String,
    pub auth_token: String, // optional server-issued device_token
    pub allow_terminal: bool,
    pub allow_file_browser: bool,
    pub allow_clipboard: bool,
    pub allow_screen_capture: bool,
    pub require_consent: bool,
    pub video_codec: String,
    pub hw_accel: String,
    pub data_dir: PathBuf,
    pub cdap_port: u16,
}

impl SidecarConfig {
    /// Build the WebSocket URL from the server address (strips API port, uses cdap_port).
    pub fn cdap_ws_url(&self) -> String {
        let addr = self.server_address.trim();
        let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
            addr.to_string()
        } else {
            format!("http://{}", addr)
        };

        if let Ok(parsed) = url::Url::parse(&with_scheme) {
            let host = parsed.host_str().unwrap_or("localhost");
            let host_part = if host.contains(':') {
                format!("[{}]", host)
            } else {
                host.to_string()
            };
            // CDAP runs on its own gateway port. Do not inherit the HTTP API
            // scheme: a server can expose HTTPS on 21114 while CDAP on 21122 is
            // plain WS. Operators can explicitly opt into WSS for CDAP with
            // BETTERDESK_CDAP_TLS=1 when the server is started with --tls-cdap.
            let ws_scheme = if std::env::var("BETTERDESK_CDAP_TLS").as_deref() == Ok("1") {
                "wss"
            } else {
                "ws"
            };
            format!("{}://{}:{}/cdap", ws_scheme, host_part, self.cdap_port)
        } else {
            format!("ws://{}:{}/cdap", addr, self.cdap_port)
        }
    }
}

fn is_placeholder_device_token(token: &str) -> bool {
    token.starts_with("BD-TOKEN-")
}

// ── SidecarManager ────────────────────────────────────────────────────────

/// Thread-safe handle to the Go agent sidecar process.
///
/// Clone is cheap — the Arc payload is shared.
#[derive(Clone)]
pub struct SidecarManager {
    inner: Arc<Inner>,
}

struct Inner {
    child: Mutex<Option<Child>>,
    /// Writable stdin of the current child process (for consent responses).
    child_stdin: Mutex<Option<ChildStdin>>,
    running: AtomicBool,
    restart_count: AtomicU32,
    binary_path: Mutex<PathBuf>,
    cdap_url: Mutex<String>,
    config_path: Mutex<PathBuf>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    /// When set to true the monitor loop will not restart.
    stop_requested: AtomicBool,
}

impl SidecarManager {
    /// Create an idle manager (no child running yet).
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                child: Mutex::new(None),
                child_stdin: Mutex::new(None),
                running: AtomicBool::new(false),
                restart_count: AtomicU32::new(0),
                binary_path: Mutex::new(PathBuf::new()),
                cdap_url: Mutex::new(String::new()),
                config_path: Mutex::new(PathBuf::new()),
                app_handle: Mutex::new(None),
                stop_requested: AtomicBool::new(false),
            }),
        }
    }

    // ── Start ──────────────────────────────────────────────────────────────

    /// Write Go config and spawn the sidecar. Starts the monitor task.
    /// Safe to call again after stop — creates a fresh process.
    pub fn start(&self, cfg: &SidecarConfig, app: tauri::AppHandle) -> Result<()> {
        let inner = &self.inner;

        // Abort any previous stop state.
        inner.stop_requested.store(false, Ordering::SeqCst);
        *inner.app_handle.lock().unwrap() = Some(app.clone());

        // Locate the Go binary.
        let binary = find_binary(&cfg.data_dir)?;
        info!("[sidecar] Using binary: {}", binary.display());
        *inner.binary_path.lock().unwrap() = binary.clone();

        // Build + write Go agent config JSON.
        let config_path = cfg.data_dir.join("go-agent-config.json");
        write_go_config(&config_path, cfg)?;
        *inner.config_path.lock().unwrap() = config_path.clone();

        let cdap_url = cfg.cdap_ws_url();
        *inner.cdap_url.lock().unwrap() = cdap_url.clone();

        // Spawn the process.
        self.spawn_process(&binary, &config_path)?;
        self.start_stdout_reader(app);

        // Start monitor task (async).
        let manager = self.clone();
        let binary_c = binary.clone();
        let config_path_c = config_path.clone();
        async_runtime::spawn(async move {
            manager.monitor_loop(&binary_c, &config_path_c).await;
        });

        Ok(())
    }

    /// Stop the sidecar, optionally waiting for graceful exit.
    pub fn stop(&self) {
        self.inner.stop_requested.store(true, Ordering::SeqCst);
        self.terminate_child();
        self.inner.running.store(false, Ordering::SeqCst);
        info!("[sidecar] Stopped.");
    }

    /// True if the child process is alive.
    pub fn is_running(&self) -> bool {
        self.inner.running.load(Ordering::SeqCst)
    }

    /// Snapshot for the frontend.
    pub fn status(&self) -> SidecarStatus {
        let pid = {
            let guard = self.inner.child.lock().unwrap();
            guard.as_ref().map(|c| c.id()).unwrap_or(0)
        };
        let running = self.inner.running.load(Ordering::SeqCst);
        let restart_count = self.inner.restart_count.load(Ordering::SeqCst);
        let binary_path = self
            .inner
            .binary_path
            .lock()
            .unwrap()
            .display()
            .to_string();
        let cdap_url = self.inner.cdap_url.lock().unwrap().clone();

        let state = if running {
            "running".to_string()
        } else if binary_path.is_empty() {
            "not_configured".to_string()
        } else {
            "stopped".to_string()
        };

        SidecarStatus {
            running,
            pid,
            restart_count,
            state,
            binary_path,
            cdap_url,
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────

    fn spawn_process(&self, binary: &PathBuf, config_path: &PathBuf) -> Result<()> {
        let mut child = Command::new(binary)
            .arg("-config")
            .arg(config_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawn betterdesk-agent from {}", binary.display()))?;

        // Take the stdin handle so we can write consent responses later.
        let child_stdin = child.stdin.take();
        let pid = child.id();
        *self.inner.child.lock().unwrap() = Some(child);
        *self.inner.child_stdin.lock().unwrap() = child_stdin;
        self.inner.running.store(true, Ordering::SeqCst);
        info!("[sidecar] Spawned betterdesk-agent (pid={})", pid);
        Ok(())
    }

    /// Write a consent response to the child's stdin.
    /// Called from `answer_consent` Tauri command.
    pub fn send_consent(&self, session_id: &str, granted: bool) {
        let mut guard = self.inner.child_stdin.lock().unwrap();
        if let Some(ref mut stdin) = *guard {
            let line = if granted {
                format!("CONSENT_GRANTED:{}\n", session_id)
            } else {
                format!("CONSENT_DENIED:{}\n", session_id)
            };
            if let Err(e) = stdin.write_all(line.as_bytes()) {
                warn!("[sidecar] Failed to write consent response: {}", e);
            }
        }
    }

    /// Write a desktop-stop request for the given session id. Used by the
    /// on-screen "Disconnect" button on the session overlay.
    pub fn send_disconnect(&self, session_id: &str) {
        let mut guard = self.inner.child_stdin.lock().unwrap();
        if let Some(ref mut stdin) = *guard {
            let line = format!("DESKTOP_STOP:{}\n", session_id);
            if let Err(e) = stdin.write_all(line.as_bytes()) {
                warn!("[sidecar] Failed to write disconnect: {}", e);
            }
        }
    }

    /// Start a background thread to read stdout from the child and emit
    /// "consent-request" Tauri events when "CONSENT_REQUEST:{...}" is seen.
    pub fn start_stdout_reader(&self, app: tauri::AppHandle) {
        // Pull stdout from the child — do this after spawn_process().
        let stdout = {
            let mut guard = self.inner.child.lock().unwrap();
            guard.as_mut().and_then(|c| c.stdout.take())
        };
        let Some(stdout) = stdout else { return };

        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if l.starts_with("CONSENT_REQUEST:") => {
                        let json_str = l.trim_start_matches("CONSENT_REQUEST:").to_string();
                        if let Err(e) = app.emit("consent-request", json_str) {
                            warn!("[sidecar] Failed to emit consent-request event: {}", e);
                        }
                    }
                    Ok(l) if l.starts_with("SESSION_START:") => {
                        // Emitted by `betterdesk-agent/agent/desktop.go` after the
                        // operator's `desktop_start` is accepted (post-consent in
                        // supervised mode, immediately in unattended mode). The
                        // payload carries `session_id`, `operator`, and `mode`.
                        // SessionOverlay listens for this to draw the per-monitor
                        // border + the collapsible session widget.
                        let json_str = l.trim_start_matches("SESSION_START:").to_string();
                        // Mirror into AgentState.active_sessions so the
                        // overlay UI can render even after the Tauri event
                        // has already fired.
                        let mut overlay_mode = String::from("supervised");
                        if let Some(state) = app.try_state::<crate::commands::AgentState>() {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                overlay_mode = parsed.get("mode").and_then(|v| v.as_str()).unwrap_or("supervised").to_string();
                                let session = crate::commands::ActiveSession {
                                    session_id: parsed.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    operator: parsed.get("operator").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    mode: overlay_mode.clone(),
                                    started_at: chrono::Utc::now().to_rfc3339(),
                                };
                                crate::commands::record_session_start(&state, session);
                            }
                        }
                        // Draw the click-through border on the primary monitor.
                        // Must run on the main (UI) thread — Tauri window APIs
                        // are not safe to call from arbitrary worker threads.
                        let app_for_overlay = app.clone();
                        let mode_for_overlay = overlay_mode.clone();
                        app.run_on_main_thread(move || {
                            crate::session_overlay::show(&app_for_overlay, &mode_for_overlay);
                        }).ok();
                        if let Err(e) = app.emit("session-active", json_str) {
                            warn!("[sidecar] Failed to emit session-active event: {}", e);
                        }
                    }
                    Ok(l) if l.starts_with("SESSION_END:") => {
                        let json_str = l.trim_start_matches("SESSION_END:").to_string();
                        let mut remaining: usize = 0;
                        if let Some(state) = app.try_state::<crate::commands::AgentState>() {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                if let Some(sid) = parsed.get("session_id").and_then(|v| v.as_str()) {
                                    crate::commands::record_session_end(&state, sid);
                                }
                            }
                            if let Ok(sessions) = state.active_sessions.lock() {
                                remaining = sessions.len();
                            }
                        }
                        // Tear down the on-screen border only when *all* sessions
                        // have ended — there could be concurrent operators.
                        if remaining == 0 {
                            let app_for_overlay = app.clone();
                            app.run_on_main_thread(move || {
                                crate::session_overlay::hide(&app_for_overlay);
                            }).ok();
                        }
                        if let Err(e) = app.emit("session-ended", json_str) {
                            warn!("[sidecar] Failed to emit session-ended event: {}", e);
                        }
                    }
                    Ok(l) => {
                        // Forward other stdout lines to the app log.
                        debug!("[go-agent] {}", l);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    fn terminate_child(&self) {
        let mut guard = self.inner.child.lock().unwrap();
        self.inner.child_stdin.lock().unwrap().take();
        if let Some(mut child) = guard.take() {
            #[cfg(unix)]
            {
                let pid = child.id() as i32;
                // SIGTERM first.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }

            #[cfg(windows)]
            {
                let _ = child.kill();
            }

            // Wait up to 5 s for graceful shutdown.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        debug!("[sidecar] Child exited: {:?}", status);
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    _ => {
                        warn!("[sidecar] Force-killing child after 5 s");
                        let _ = child.kill();
                        break;
                    }
                }
            }
        }
    }

    /// Background task — polls child every 5 s, restarts on exit.
    async fn monitor_loop(&self, binary: &PathBuf, config_path: &PathBuf) {
        const BASE_DELAY_SECS: u64 = 5;
        const MAX_DELAY_SECS: u64 = 300;

        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            if self.inner.stop_requested.load(Ordering::SeqCst) {
                debug!("[sidecar] Monitor: stop requested, exiting loop");
                return;
            }

            let exited = {
                let mut guard = self.inner.child.lock().unwrap();
                if let Some(child) = guard.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            warn!("[sidecar] Process exited: {:?}", status);
                            true
                        }
                        Ok(None) => false, // still running
                        Err(e) => {
                            error!("[sidecar] try_wait error: {}", e);
                            true
                        }
                    }
                } else {
                    false
                }
            };

            if exited {
                self.inner.running.store(false, Ordering::SeqCst);

                if self.inner.stop_requested.load(Ordering::SeqCst) {
                    return;
                }

                let count = self.inner.restart_count.fetch_add(1, Ordering::SeqCst);
                let delay = (BASE_DELAY_SECS * (1u64 << count.min(6))).min(MAX_DELAY_SECS);
                warn!("[sidecar] Restarting in {}s (attempt #{})", delay, count + 1);
                tokio::time::sleep(Duration::from_secs(delay)).await;

                if self.inner.stop_requested.load(Ordering::SeqCst) {
                    return;
                }

                if let Err(e) = self.spawn_process(binary, config_path) {
                    error!("[sidecar] Restart failed: {}", e);
                } else if let Some(app) = self.inner.app_handle.lock().unwrap().clone() {
                    self.start_stdout_reader(app);
                }
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Kill child when the Tauri app exits.
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

// ── Binary discovery ──────────────────────────────────────────────────────

/// Find the `betterdesk-agent` binary.
/// Search order: env var → exe dir → data dir → PATH.
fn find_binary(data_dir: &PathBuf) -> Result<PathBuf> {
    let bin_name = if cfg!(windows) {
        "betterdesk-agent.exe"
    } else {
        "betterdesk-agent"
    };

    // 1. Developer override.
    if let Ok(path) = std::env::var("BETTERDESK_AGENT_BIN") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
        warn!(
            "[sidecar] BETTERDESK_AGENT_BIN set but file not found: {}",
            p.display()
        );
    }

    // 2. Same directory as the Tauri executable. Packaged Tauri externalBin
    // files may include the target triple, while dev installs often use the
    // plain name.
    if let Ok(exe) = std::env::current_exe() {
        let exe_dir = exe.parent().unwrap_or(&exe);
        for candidate in binary_candidates(exe_dir, bin_name) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 3. App data directory (downloaded/extracted binary).
    for candidate in binary_candidates(data_dir, bin_name) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // 4. System PATH.
    if let Ok(output) = Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(if cfg!(windows) {
            "betterdesk-agent.exe"
        } else {
            "betterdesk-agent"
        })
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path_str.is_empty() {
                let p = PathBuf::from(path_str);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
    }

    Err(anyhow!(
        "betterdesk-agent binary not found. Searched: \
         $BETTERDESK_AGENT_BIN, exe dir, {}, PATH. \
         Download from https://github.com/UNITRONIX/BetterDesk/releases \
         or install via the ALL-IN-ONE installer.",
        data_dir.display()
    ))
}

fn binary_candidates(dir: &std::path::Path, bin_name: &str) -> Vec<PathBuf> {
    let mut out = vec![dir.join(bin_name)];

    let prefix = if cfg!(windows) {
        "betterdesk-agent-"
    } else {
        "betterdesk-agent-"
    };

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let matches = if cfg!(windows) {
                name.starts_with(prefix) && name.ends_with(".exe")
            } else {
                name.starts_with(prefix)
            };
            if matches {
                out.push(path);
            }
        }
    }

    out
}

// ── Config writer ──────────────────────────────────────────────────────────

/// Write the Go-format JSON config file consumed by betterdesk-agent.
fn write_go_config(path: &PathBuf, cfg: &SidecarConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let auth_method;
    let api_key;
    let device_token;

    if !cfg.api_key.is_empty() {
        auth_method = "api_key";
        api_key = cfg.api_key.clone();
        device_token = String::new();
    } else if !cfg.auth_token.is_empty() && !is_placeholder_device_token(&cfg.auth_token) {
        auth_method = "device_token";
        api_key = String::new();
        device_token = cfg.auth_token.clone();
    } else {
        return Err(anyhow!(
            "CDAP sidecar requires a valid API key from Settings or a server-issued device token."
        ));
    }

    let go_cfg = GoAgentConfig {
        server: cfg.cdap_ws_url(),
        auth_method: auth_method.to_string(),
        api_key,
        device_token,
        device_id: cfg.device_id.clone(),
        device_name: cfg.device_name.clone(),
        device_type: "os_agent".to_string(),
        tags: vec!["tauri-agent".to_string()],
        terminal: cfg.allow_terminal,
        file_browser: cfg.allow_file_browser,
        clipboard: cfg.allow_clipboard,
        screenshot: cfg.allow_screen_capture,
        require_consent: cfg.require_consent,
        video_codec: cfg.video_codec.clone(),
        hw_accel: cfg.hw_accel.clone(),
        heartbeat_sec: 15,
        reconnect_sec: 5,
        max_reconnect: 300,
        log_level: "info".to_string(),
        data_dir: cfg.data_dir.to_string_lossy().to_string(),
    };

    let json = serde_json::to_string_pretty(&go_cfg)?;
    std::fs::write(path, json)
        .with_context(|| format!("write Go agent config to {}", path.display()))?;

    info!("[sidecar] Config written to {}", path.display());
    Ok(())
}
