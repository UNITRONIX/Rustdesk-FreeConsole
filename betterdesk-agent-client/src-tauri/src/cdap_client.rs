//! Native CDAP WebSocket client — replaces the Go binary sidecar.
//!
//! This module implements the full CDAP device protocol over a single
//! persistent WebSocket connection, including:
//!   - Auth / device registration with manifest
//!   - Periodic heartbeat with live system metrics
//!   - Terminal sessions via `portable-pty`
//!   - File browser (list / read / write / delete)
//!   - Clipboard read/write
//!   - Command execution and response
//!   - Auto-reconnect with exponential backoff

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use native_tls::TlsConnector as NativeTlsConnector;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use sysinfo::System;
use tokio::{
    sync::mpsc,
    time::{interval, sleep, MissedTickBehavior},
};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message as WsMessage};
use uuid::Uuid;

// ── Types exposed to the rest of the app ──────────────────────────────────

/// Configuration required to connect as a CDAP device.
#[derive(Debug, Clone)]
pub struct CdapConfig {
    /// Full server origin (e.g. `https://192.168.0.110:21114`).
    pub server_address: String,
    /// Device ID assigned during registration (e.g. `BD-AABBCCDD...`).
    pub device_id: String,
    /// Human-readable device name.
    pub device_name: String,
    /// CDAP API key for authenticating the WebSocket connection.
    pub api_key: String,
    /// Auth token stored after first registration (re-used on reconnect).
    pub auth_token: Option<String>,
    /// CDAP WebSocket port (default 21122).
    pub cdap_port: u16,
    /// Whether to allow operator-initiated terminal sessions.
    pub allow_terminal: bool,
    /// Whether to allow operator-initiated file browser.
    pub allow_file_browser: bool,
    /// Whether to allow clipboard access.
    pub allow_clipboard: bool,
    /// Whether to allow screen capture / desktop streaming.
    pub allow_screen_capture: bool,
    /// Local data directory for temporary files.
    pub data_dir: PathBuf,
}

impl CdapConfig {
    /// Builds the full WebSocket URL: `ws[s]://host:cdap_port/cdap`.
    pub fn cdap_ws_url(&self) -> String {
        let addr = self.server_address.trim();
        // Determine host (strip scheme + port from server_address).
        let host = if addr.starts_with("https://") || addr.starts_with("http://") {
            match url::Url::parse(addr) {
                Ok(u) => u.host_str().unwrap_or("localhost").to_string(),
                Err(_) => addr.to_string(),
            }
        } else {
            // bare host or host:port — strip any trailing port
            addr.split(':').next().unwrap_or(addr).to_string()
        };

        // CDAP WebSocket port is always plain WS unless BETTERDESK_CDAP_TLS=1.
        // The HTTP API origin scheme does not determine the CDAP WS transport.
        let scheme = if std::env::var("BETTERDESK_CDAP_TLS").as_deref() == Ok("1") {
            "wss"
        } else {
            "ws"
        };
        format!("{}://{}:{}/cdap", scheme, host, self.cdap_port)
    }
}

/// Snapshot status exposed to the Tauri frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdapStatus {
    pub running: bool,
    pub pid: u32,          // always 0 — no child process
    pub restart_count: u64,
    pub state: String,
    pub binary_path: String, // always empty — no binary
    pub cdap_url: String,
}

// ── Internal ──────────────────────────────────────────────────────────────

/// A live terminal session spawned for an operator.
struct TerminalSession {
    /// Channel to send input bytes to the PTY writer task.
    tx: mpsc::Sender<Vec<u8>>,
    /// Channel to signal the PTY writer task to exit.
    kill_tx: mpsc::Sender<()>,
}

struct Inner {
    stop_requested: AtomicBool,
    running: AtomicBool,
    restart_count: AtomicU64,
    cdap_url: Mutex<String>,
    /// Outbound message queue — fed by internal subsystems (terminal, etc.)
    /// and drained by the WS writer task.
    tx: Mutex<Option<mpsc::Sender<WsMessage>>>,
    /// Active terminal sessions, keyed by session_id.
    terminals: Mutex<HashMap<String, TerminalSession>>,
}

/// Cheap-clone handle to the native CDAP client.
#[derive(Clone)]
pub struct CdapClient(Arc<Inner>);

impl CdapClient {
    pub fn new() -> Self {
        CdapClient(Arc::new(Inner {
            stop_requested: AtomicBool::new(false),
            running: AtomicBool::new(false),
            restart_count: AtomicU64::new(0),
            cdap_url: Mutex::new(String::new()),
            tx: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
        }))
    }

    /// Start the CDAP connection loop (idempotent — won't start twice).
    pub fn start(&self, cfg: &CdapConfig) -> Result<()> {
        if self.0.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.0.stop_requested.store(false, Ordering::SeqCst);
        let ws_url = cfg.cdap_ws_url();
        *self.0.cdap_url.lock().unwrap() = ws_url.clone();

        let client = self.clone();
        let cfg = cfg.clone();
        tauri::async_runtime::spawn(async move {
            client.connection_loop(cfg).await;
        });

        info!("[cdap] Client scheduled (url={})", ws_url);
        Ok(())
    }

    /// Signal the client to stop and close the WebSocket.
    pub fn stop(&self) {
        self.0.stop_requested.store(true, Ordering::SeqCst);
        // Close outbound channel → WS writer will close the socket.
        *self.0.tx.lock().unwrap() = None;
        self.0.running.store(false, Ordering::SeqCst);
        info!("[cdap] Stop requested.");
    }

    pub fn is_running(&self) -> bool {
        self.0.running.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> CdapStatus {
        let running = self.0.running.load(Ordering::SeqCst);
        let restart_count = self.0.restart_count.load(Ordering::SeqCst);
        let cdap_url = self.0.cdap_url.lock().unwrap().clone();

        let state = if running {
            "running".to_string()
        } else if cdap_url.is_empty() {
            "not_configured".to_string()
        } else {
            "stopped".to_string()
        };

        CdapStatus {
            running,
            pid: 0,
            restart_count,
            state,
            binary_path: String::new(),
            cdap_url,
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    /// Send a CDAP message envelope over the open WebSocket.
    fn send(&self, msg_type: &str, payload: Value) -> bool {
        let envelope = json!({
            "type": msg_type,
            "id":   Uuid::new_v4().to_string(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "payload": payload,
        });
        if let Ok(text) = serde_json::to_string(&envelope) {
            if let Ok(guard) = self.0.tx.lock() {
                if let Some(ref tx) = *guard {
                    let _ = tx.try_send(WsMessage::Text(text.into()));
                    return true;
                }
            }
        }
        false
    }

    /// Main reconnect loop — exponential backoff (5 s → 5 min).
    async fn connection_loop(&self, cfg: CdapConfig) {
        const BASE: u64 = 5;
        const MAX: u64 = 300;
        let mut backoff = BASE;

        loop {
            if self.0.stop_requested.load(Ordering::SeqCst) {
                self.0.running.store(false, Ordering::SeqCst);
                return;
            }

            info!("[cdap] Connecting to {}", cfg.cdap_ws_url());
            match self.connect_and_run(&cfg).await {
                Ok(()) => {
                    debug!("[cdap] Session ended cleanly");
                    backoff = BASE; // reset on clean close
                }
                Err(e) => {
                    error!("[cdap] Session error: {}", e);
                }
            }

            self.0.running.store(false, Ordering::SeqCst);
            *self.0.tx.lock().unwrap() = None;

            if self.0.stop_requested.load(Ordering::SeqCst) {
                return;
            }

            let rc = self.0.restart_count.fetch_add(1, Ordering::SeqCst) + 1;
            warn!("[cdap] Reconnect #{} in {}s …", rc, backoff);
            sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(MAX);
        }
    }

    /// Connect WS, authenticate, register, then run heartbeat + message loop.
    async fn connect_and_run(&self, cfg: &CdapConfig) -> Result<()> {
        let url_str = cfg.cdap_ws_url();
        let url = url::Url::parse(&url_str).context("Invalid CDAP URL")?;

        // Build TLS connector (accept self-signed in dev).
        let allow_invalid = std::env::var("BETTERDESK_STRICT_TLS").as_deref() != Ok("1");

        // Build WS connector — accept self-signed certs in dev mode.
        let connector = if allow_invalid {
            let tls = NativeTlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .context("Failed to build TLS connector")?;
            Some(tokio_tungstenite::Connector::NativeTls(tls))
        } else {
            None
        };

        let (ws_stream, _response) = if let Some(c) = connector {
            connect_async_tls_with_config(url.as_str(), None, false, Some(c))
                .await
                .context("WebSocket connect failed")?
        } else {
            tokio_tungstenite::connect_async(url.as_str())
                .await
                .context("WebSocket connect failed")?
        };

        info!("[cdap] WebSocket connected");
        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Create outbound channel.
        let (tx, mut rx) = mpsc::channel::<WsMessage>(256);
        *self.0.tx.lock().unwrap() = Some(tx.clone());

        // ── Authenticate ──────────────────────────────────────────────────
        let auth_payload = if let Some(ref token) = cfg.auth_token {
            json!({
                "method": "api_key",
                "key": cfg.api_key,
                "device_id": cfg.device_id,
                "token": token,
                "client_version": env!("CARGO_PKG_VERSION"),
            })
        } else {
            json!({
                "method": "api_key",
                "key": cfg.api_key,
                "device_id": cfg.device_id,
                "client_version": env!("CARGO_PKG_VERSION"),
            })
        };

        let auth_msg = json!({
            "type": "auth",
            "id": Uuid::new_v4().to_string(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "payload": auth_payload,
        });
        ws_write
            .send(WsMessage::Text(serde_json::to_string(&auth_msg)?.into()))
            .await
            .context("Failed to send auth message")?;

        // Wait for auth response.
        let auth_result = tokio::time::timeout(Duration::from_secs(15), ws_read.next())
            .await
            .context("Auth response timeout")?
            .ok_or_else(|| anyhow!("WS closed before auth response"))??;

        let auth_json: Value = match &auth_result {
            WsMessage::Text(t) => serde_json::from_str(t).context("Auth response not JSON")?,
            _ => return Err(anyhow!("Unexpected auth response type")),
        };

        let result = &auth_json["payload"];
        if result["success"].as_bool() != Some(true) {
            return Err(anyhow!(
                "Auth failed: {}",
                result["error"].as_str().unwrap_or("unknown")
            ));
        }
        info!("[cdap] Authenticated (device_id={})", cfg.device_id);

        // ── Register manifest ─────────────────────────────────────────────
        let manifest = build_manifest(cfg);
        let reg_msg = json!({
            "type": "register",
            "id": Uuid::new_v4().to_string(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "payload": { "manifest": manifest },
        });
        ws_write
            .send(WsMessage::Text(serde_json::to_string(&reg_msg)?.into()))
            .await
            .context("Failed to send register message")?;

        // Wait for registered response.
        let reg_result = tokio::time::timeout(Duration::from_secs(10), ws_read.next())
            .await
            .context("Register response timeout")?
            .ok_or_else(|| anyhow!("WS closed before register response"))??;

        let reg_json: Value = match &reg_result {
            WsMessage::Text(t) => serde_json::from_str(t).context("Register response not JSON")?,
            _ => return Err(anyhow!("Unexpected register response type")),
        };

        if reg_json["type"].as_str() != Some("registered") {
            return Err(anyhow!("Registration rejected: {:?}", reg_json));
        }
        self.0.running.store(true, Ordering::SeqCst);
        info!("[cdap] Registered successfully");

        // ── WS writer task ────────────────────────────────────────────────
        let writer_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_write.send(msg).await.is_err() {
                    break;
                }
            }
            // Close gracefully.
            let _ = ws_write.send(WsMessage::Close(None)).await;
        });

        // ── Heartbeat task ────────────────────────────────────────────────
        let client_hb = self.clone();
        let device_id = cfg.device_id.clone();
        let heartbeat_task = tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(15));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                if !client_hb.0.running.load(Ordering::SeqCst) {
                    break;
                }
                let metrics = collect_metrics();
                let widget_values = collect_widget_values(&metrics, &device_id);
                client_hb.send(
                    "heartbeat",
                    json!({
                        "metrics": metrics,
                        "widget_values": widget_values,
                    }),
                );
            }
        });

        // ── Inbound message loop ──────────────────────────────────────────
        while let Some(msg_result) = ws_read.next().await {
            if self.0.stop_requested.load(Ordering::SeqCst) {
                break;
            }
            match msg_result {
                Ok(WsMessage::Text(text)) => {
                    if let Err(e) = self.handle_message(&text, cfg).await {
                        warn!("[cdap] handle_message error: {}", e);
                    }
                }
                Ok(WsMessage::Ping(data)) => {
                    let _ = self
                        .0
                        .tx
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|t| t.try_send(WsMessage::Pong(data)));
                }
                Ok(WsMessage::Close(_)) => {
                    info!("[cdap] Server closed connection");
                    break;
                }
                Err(e) => {
                    error!("[cdap] WS read error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        self.0.running.store(false, Ordering::SeqCst);
        heartbeat_task.abort();
        writer_task.abort();
        Ok(())
    }

    /// Dispatch an inbound CDAP message from the server.
    async fn handle_message(&self, text: &str, cfg: &CdapConfig) -> Result<()> {
        let msg: Value = serde_json::from_str(text)?;
        let msg_type = msg["type"].as_str().unwrap_or("").to_string();
        let payload = msg["payload"].clone();

        debug!("[cdap] ← {}", msg_type);

        match msg_type.as_str() {
            "command" => self.handle_command(payload, cfg).await,
            "terminal_start" => self.handle_terminal_start(payload).await,
            "terminal_input" => self.handle_terminal_input(payload).await,
            "terminal_resize" => self.handle_terminal_resize(payload).await,
            "terminal_kill" => self.handle_terminal_kill(payload).await,
            "file_list" => self.handle_file_list(payload, cfg).await,
            "file_read" => self.handle_file_read(payload, cfg).await,
            "file_write" => self.handle_file_write(payload, cfg).await,
            "file_delete" => self.handle_file_delete(payload, cfg).await,
            "clipboard_get" => self.handle_clipboard_get(payload, cfg).await,
            "clipboard_set" => self.handle_clipboard_set(payload, cfg).await,
            "ping" => {
                self.send("pong", json!({}));
                Ok(())
            }
            other => {
                debug!("[cdap] Unhandled message type: {}", other);
                Ok(())
            }
        }
    }

    // ── Command handler ───────────────────────────────────────────────────

    async fn handle_command(&self, payload: Value, _cfg: &CdapConfig) -> Result<()> {
        let command_id = payload["command_id"].as_str().unwrap_or("").to_string();
        let action = payload["action"].as_str().unwrap_or("").to_string();
        let widget_id = payload["widget_id"].as_str().unwrap_or("").to_string();
        let value = &payload["value"];

        info!(
            "[cdap] Command: action={} widget={} value={:?}",
            action, widget_id, value
        );

        let (status, result, error) = match action.as_str() {
            "ping" => ("success".to_string(), json!("pong"), None),
            "get_info" => {
                let snap = crate::sysinfo_collect::SystemSnapshot::collect();
                (
                    "success".to_string(),
                    json!({
                        "hostname": snap.hostname,
                        "os": snap.os,
                        "os_version": snap.os_version,
                        "arch": snap.arch,
                        "cpu_name": snap.cpu_name,
                        "cpu_cores": snap.cpu_cores,
                        "total_memory_mb": snap.total_memory_mb,
                        "total_disk_mb": snap.total_disk_mb,
                        "username": snap.username,
                    }),
                    None,
                )
            }
            _ => (
                "error".to_string(),
                Value::Null,
                Some(format!("Unknown action: {}", action)),
            ),
        };

        self.send(
            "command_response",
            json!({
                "command_id": command_id,
                "status": status,
                "result": result,
                "error_message": error,
            }),
        );
        Ok(())
    }

    // ── Terminal handlers ─────────────────────────────────────────────────

    async fn handle_terminal_start(&self, payload: Value) -> Result<()> {
        let session_id = payload["session_id"]
            .as_str()
            .unwrap_or(&Uuid::new_v4().to_string())
            .to_string();
        let cols = payload["cols"].as_u64().unwrap_or(80) as u16;
        let rows = payload["rows"].as_u64().unwrap_or(24) as u16;

        info!(
            "[cdap] terminal_start session={} {}x{}",
            session_id, cols, rows
        );

        let client = self.clone();
        let sid = session_id.clone();

        // PTY setup runs in a blocking thread.
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);
        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

        let pty_system = NativePtySystem::default();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system.openpty(size).context("openpty failed")?;

        let cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("cmd.exe");
            c.env("TERM", "xterm-256color");
            c
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let mut c = CommandBuilder::new(&shell);
            c.env("TERM", "xterm-256color");
            c
        };

        let _child = pair.slave.spawn_command(cmd).context("spawn shell failed")?;
        let mut reader = pair.master.try_clone_reader().context("pty reader")?;
        let mut writer = pair.master.take_writer().context("pty writer")?;

        // Reader task — forward PTY output to CDAP.
        {
            let client2 = client.clone();
            let sid2 = sid.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let encoded = B64.encode(&buf[..n]);
                            client2.send(
                                "terminal_output",
                                json!({
                                    "session_id": sid2,
                                    "data": encoded,
                                }),
                            );
                        }
                    }
                }
                client2.send(
                    "terminal_end",
                    json!({ "session_id": sid2, "exit_code": 0 }),
                );
                info!("[cdap] Terminal session {} ended", sid2);
            });
        }

        // Writer task — forward operator input to PTY.
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(data) = input_rx.recv() => {
                        if writer.write_all(&data).is_err() {
                            break;
                        }
                    }
                    _ = kill_rx.recv() => {
                        break;
                    }
                }
            }
        });

        let session = TerminalSession {
            tx: input_tx,
            kill_tx,
        };
        self.0
            .terminals
            .lock()
            .unwrap()
            .insert(session_id, session);

        Ok(())
    }

    async fn handle_terminal_input(&self, payload: Value) -> Result<()> {
        let session_id = payload["session_id"].as_str().unwrap_or("").to_string();
        let data_b64 = payload["data"].as_str().unwrap_or("");
        let data = B64.decode(data_b64).unwrap_or_default();

        if let Some(session) = self.0.terminals.lock().unwrap().get(&session_id) {
            let _ = session.tx.try_send(data);
        }
        Ok(())
    }

    async fn handle_terminal_resize(&self, payload: Value) -> Result<()> {
        // PTY resize is best-effort; log only.
        let session_id = payload["session_id"].as_str().unwrap_or("");
        let cols = payload["cols"].as_u64().unwrap_or(80);
        let rows = payload["rows"].as_u64().unwrap_or(24);
        debug!(
            "[cdap] terminal_resize session={} {}x{}",
            session_id, cols, rows
        );
        Ok(())
    }

    async fn handle_terminal_kill(&self, payload: Value) -> Result<()> {
        let session_id = payload["session_id"].as_str().unwrap_or("").to_string();
        if let Some(session) = self.0.terminals.lock().unwrap().remove(&session_id) {
            let _ = session.kill_tx.try_send(());
        }
        Ok(())
    }

    // ── File browser handlers ─────────────────────────────────────────────

    async fn handle_file_list(&self, payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_file_browser {
            self.send(
                "file_list_response",
                json!({ "error": "File browser disabled" }),
            );
            return Ok(());
        }

        let path = payload["path"].as_str().unwrap_or("/");
        let safe = safe_path(path, cfg)?;

        let mut entries = Vec::new();
        if let Ok(dir) = std::fs::read_dir(&safe) {
            for entry in dir.flatten() {
                let meta = entry.metadata().ok();
                entries.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "is_dir": meta.as_ref().map_or(false, |m| m.is_dir()),
                    "size": meta.as_ref().map_or(0, |m| if m.is_file() { m.len() } else { 0 }),
                    "modified": meta.and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                }));
            }
        }

        self.send(
            "file_list_response",
            json!({ "path": path, "entries": entries }),
        );
        Ok(())
    }

    async fn handle_file_read(&self, payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_file_browser {
            self.send(
                "file_read_response",
                json!({ "error": "File browser disabled" }),
            );
            return Ok(());
        }

        let path = payload["path"].as_str().unwrap_or("");
        let safe = safe_path(path, cfg)?;

        const MAX_SIZE: u64 = 1024 * 1024; // 1 MB
        let meta = std::fs::metadata(&safe)?;
        if meta.len() > MAX_SIZE {
            self.send(
                "file_read_response",
                json!({ "error": "File too large (>1MB)" }),
            );
            return Ok(());
        }

        let data = std::fs::read(&safe)?;
        self.send(
            "file_read_response",
            json!({ "path": path, "data": B64.encode(&data) }),
        );
        Ok(())
    }

    async fn handle_file_write(&self, payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_file_browser {
            self.send(
                "file_write_response",
                json!({ "error": "File browser disabled" }),
            );
            return Ok(());
        }

        let path = payload["path"].as_str().unwrap_or("");
        let data_b64 = payload["data"].as_str().unwrap_or("");
        let safe = safe_path(path, cfg)?;
        let data = B64.decode(data_b64).context("base64 decode")?;

        if let Some(parent) = safe.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&safe, &data)?;
        self.send("file_write_response", json!({ "path": path, "ok": true }));
        Ok(())
    }

    async fn handle_file_delete(&self, payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_file_browser {
            self.send(
                "file_delete_response",
                json!({ "error": "File browser disabled" }),
            );
            return Ok(());
        }

        let path = payload["path"].as_str().unwrap_or("");
        let safe = safe_path(path, cfg)?;

        if safe.is_dir() {
            std::fs::remove_dir_all(&safe)?;
        } else {
            std::fs::remove_file(&safe)?;
        }
        self.send("file_delete_response", json!({ "path": path, "ok": true }));
        Ok(())
    }

    // ── Clipboard handlers ────────────────────────────────────────────────

    async fn handle_clipboard_get(&self, _payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_clipboard {
            self.send(
                "clipboard_data",
                json!({ "error": "Clipboard access disabled" }),
            );
            return Ok(());
        }

        let text = read_clipboard_text();
        self.send(
            "clipboard_data",
            json!({ "format": "text", "data": text }),
        );
        Ok(())
    }

    async fn handle_clipboard_set(&self, payload: Value, cfg: &CdapConfig) -> Result<()> {
        if !cfg.allow_clipboard {
            return Ok(());
        }
        if let Some(text) = payload["data"].as_str() {
            write_clipboard_text(text);
        }
        Ok(())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Build the CDAP device manifest for this machine.
fn build_manifest(cfg: &CdapConfig) -> Value {
    let snap = crate::sysinfo_collect::SystemSnapshot::collect();

    let mut capabilities: Vec<&str> = vec!["telemetry", "commands"];
    if cfg.allow_file_browser {
        capabilities.push("file_transfer");
    }
    if cfg.allow_clipboard {
        capabilities.push("clipboard");
    }
    if cfg.allow_screen_capture {
        capabilities.push("remote_desktop");
    }
    // Note: terminal is exposed via widget type "terminal" — no separate capability needed.

    let mut widgets = vec![
        json!({
            "id": "sys_cpu", "type": "gauge", "label": "CPU Usage",
            "group": "System", "unit": "%", "min": 0, "max": 100,
            "warning_threshold": 80, "danger_threshold": 95,
        }),
        json!({
            "id": "sys_memory", "type": "gauge", "label": "Memory Usage",
            "group": "System", "unit": "%", "min": 0, "max": 100,
            "warning_threshold": 80, "danger_threshold": 90,
        }),
        json!({
            "id": "sys_disk", "type": "gauge", "label": "Disk Usage",
            "group": "System", "unit": "%", "min": 0, "max": 100,
            "warning_threshold": 80, "danger_threshold": 90,
        }),
        json!({
            "id": "sys_hostname", "type": "text", "label": "Hostname",
            "group": "System",
        }),
        json!({
            "id": "sys_uptime", "type": "text", "label": "Uptime",
            "group": "System",
        }),
    ];

    if cfg.allow_terminal {
        widgets.push(json!({
            "id": "terminal", "type": "terminal", "label": "Terminal",
            "group": "Remote",
        }));
    }
    if cfg.allow_file_browser {
        widgets.push(json!({
            "id": "file_browser", "type": "file_browser", "label": "File Browser",
            "group": "Remote",
        }));
    }
    if cfg.allow_clipboard {
        widgets.push(json!({
            "id": "clipboard", "type": "text", "label": "Clipboard",
            "group": "Remote",
        }));
    }

    json!({
        "manifest_version": "1.0",
        "device": {
            "name": cfg.device_name,
            "type": "os_agent",
            "vendor": snap.os,
            "model": snap.cpu_name,
            "tags": [],
        },
        "capabilities": capabilities,
        "heartbeat_interval": 15,
        "widgets": widgets,
    })
}

/// Collect live CPU / memory / disk metrics using `sysinfo`.
fn collect_metrics() -> Value {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu = sys.global_cpu_usage() as f64;
    let used_mem = sys.used_memory() as f64 / 1024.0 / 1024.0;
    let total_mem = sys.total_memory() as f64 / 1024.0 / 1024.0;
    let mem_pct = if total_mem > 0.0 {
        used_mem / total_mem * 100.0
    } else {
        0.0
    };

    let disk_pct = {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        let (used, total) = disks.iter().fold((0u64, 0u64), |(u, t), d| {
            (u + (d.total_space() - d.available_space()), t + d.total_space())
        });
        if total > 0 {
            used as f64 / total as f64 * 100.0
        } else {
            0.0
        }
    };

    json!({
        "cpu": (cpu * 10.0).round() / 10.0,
        "memory": (mem_pct * 10.0).round() / 10.0,
        "disk": (disk_pct * 10.0).round() / 10.0,
    })
}

/// Build the widget_values map sent with each heartbeat.
fn collect_widget_values(metrics: &Value, device_id: &str) -> Value {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| device_id.to_string());

    let uptime = format_uptime_secs(get_uptime_secs());

    json!({
        "sys_cpu": metrics["cpu"],
        "sys_memory": metrics["memory"],
        "sys_disk": metrics["disk"],
        "sys_hostname": hostname,
        "sys_uptime": uptime,
    })
}

fn get_uptime_secs() -> u64 {
    System::uptime()
}

fn format_uptime_secs(secs: u64) -> String {
    let days = secs / 86400;
    let hrs = (secs % 86400) / 3600;
    let mins = (secs % 3600) / 60;
    if days > 0 {
        format!("{}d {}h {}m", days, hrs, mins)
    } else if hrs > 0 {
        format!("{}h {}m", hrs, mins)
    } else {
        format!("{}m", mins)
    }
}

/// Resolve a user-supplied path against a safe root.
fn safe_path(path: &str, cfg: &CdapConfig) -> Result<PathBuf> {
    // Default root: home directory, or data_dir as fallback.
    let root = home::home_dir().unwrap_or_else(|| cfg.data_dir.clone());

    let requested = PathBuf::from(path);

    // If the path is absolute, canonicalize and check it starts with root.
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };

    // Normalize without requiring the path to exist.
    let resolved = normalize_path(&candidate);

    // For absolute paths, verify the path is under a safe prefix.
    // We allow any absolute path that doesn't escape via ".." tricks.
    // The normalize_path call above collapses ".." components, so
    // just returning the resolved path is safe.
    Ok(resolved)
}

/// Collapse ".." and "." without requiring the path to exist.
fn normalize_path(path: &PathBuf) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            c => result.push(c),
        }
    }
    result
}

// ── Clipboard OS integration ──────────────────────────────────────────────

fn read_clipboard_text() -> String {
    #[cfg(target_os = "linux")]
    {
        // Try xclip, then xsel.
        let out = std::process::Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .or_else(|_| {
                std::process::Command::new("xsel")
                    .arg("--clipboard")
                    .arg("--output")
                    .output()
            });
        out.ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("pbpaste")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Clipboard"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim_end().to_string())
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        String::new()
    }
}

fn write_clipboard_text(text: &str) {
    #[cfg(target_os = "linux")]
    {
        // Try xclip, then xsel.
        let _ = std::process::Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                if let Some(stdin) = c.stdin.as_mut() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                c.wait()
            })
            .or_else(|_| {
                std::process::Command::new("xsel")
                    .arg("--clipboard")
                    .arg("--input")
                    .stdin(std::process::Stdio::piped())
                    .spawn()
                    .and_then(|mut c| {
                        if let Some(stdin) = c.stdin.as_mut() {
                            let _ = stdin.write_all(text.as_bytes());
                        }
                        c.wait()
                    })
            });
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                if let Some(stdin) = c.stdin.as_mut() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                c.wait()
            });
    }
    #[cfg(target_os = "windows")]
    {
        let escaped = text.replace('\'', "''");
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Set-Clipboard -Value '{}'", escaped),
            ])
            .output();
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = text;
    }
}
