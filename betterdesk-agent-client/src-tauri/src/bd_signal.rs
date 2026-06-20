//! BetterDesk signal/introspection WebSocket client.
//!
//! Connects to the Node.js console at `/ws/bd-signal?device_id=X&token=Y`
//! and answers operator-initiated requests (`services.list`, `processes.list`,
//! `events.list`, `activity.get`, `files.browse`, `files.read`,
//! `screenshot.capture`, `terminal.execute`).
//!
//! The protocol is the same one consumed by `services/bdRelay.js`:
//!   - Console sends:  `{ type, request_id, payload }`
//!   - Agent replies:  `{ type: "command_response", request_id, ok, data?, error? }`
//!
//! Reconnect loop with exponential backoff (max 60s).

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use native_tls::TlsConnector as NativeTlsConnector;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message as WsMessage};

use crate::commands::AgentState;
use crate::config::AgentConfig;

/// Snapshot of the parts of `AgentConfig` the WS task needs.
#[derive(Clone, Debug)]
struct ConnSpec {
    server_address: String,
    device_id: String,
    auth_token: String,
    allow_terminal: bool,
    allow_file_browser: bool,
    allow_screen_capture: bool,
    allow_clipboard: bool,
}

impl ConnSpec {
    fn from_config(cfg: &AgentConfig) -> Option<Self> {
        if !cfg.is_registered() {
            return None;
        }
        Some(Self {
            server_address: cfg.server_address.clone(),
            device_id: cfg.device_id.clone(),
            auth_token: if cfg.auth_token.is_empty() {
                cfg.device_id.clone() // fallback — current Node.js endpoint accepts any non-empty token
            } else {
                cfg.auth_token.clone()
            },
            allow_terminal: cfg.allow_terminal,
            allow_file_browser: cfg.allow_file_browser,
            allow_screen_capture: cfg.allow_screen_capture,
            allow_clipboard: cfg.allow_clipboard,
        })
    }
}

/// Convert `https://host:21114` → `wss://host:5000/ws/bd-signal?device_id=X&token=Y`
/// (`http://` → `ws://`). Falls back to `ws://host:5000/...` if parse fails.
#[allow(dead_code)]
fn build_ws_url(server_address: &str, device_id: &str, token: &str) -> String {
    let addr = server_address.trim();
    let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };

    let (host, ws_scheme) = if let Ok(parsed) = url::Url::parse(&with_scheme) {
        let h = parsed.host_str().unwrap_or("localhost").to_string();
        let s = if parsed.scheme() == "https" { "wss" } else { "ws" };
        (h, s)
    } else {
        (addr.split(':').next().unwrap_or(addr).to_string(), "ws")
    };

    let console_port = std::env::var("BETTERDESK_CONSOLE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(5000);

    format!(
        "{}://{}:{}/ws/bd-signal?device_id={}&token={}",
        ws_scheme,
        host,
        console_port,
        urlencoding_encode(device_id),
        urlencoding_encode(token),
    )
}

/// Minimal URL-encoder (avoids pulling in another crate). Only encodes the
/// characters relevant for opaque IDs / tokens: space, =, &, ?, #, %.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Spawn the long-running bd-signal task. Idempotent: caller is expected to
/// invoke this once on startup. Quits silently if the device is not yet
/// registered or the user toggles off the relevant capabilities.
pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Initial delay so the panel finishes booting and the user has a
        // chance to complete enrollment before we start hitting the WS.
        sleep(Duration::from_secs(3)).await;

        let mut backoff_secs = 1u64;
        loop {
            // Re-read config each iteration so capability toggles take effect
            // on next reconnect without restarting the app.
            let spec = match resolve_spec(&app) {
                Some(s) => s,
                None => {
                    sleep(Duration::from_secs(15)).await;
                    continue;
                }
            };

            match run_one_connection(&app, &spec).await {
                Ok(()) => {
                    info!("[bd-signal] Connection closed cleanly — reconnecting");
                    backoff_secs = 1;
                }
                Err(e) => {
                    warn!("[bd-signal] Connection error: {} — backoff {}s", e, backoff_secs);
                    sleep(Duration::from_secs(backoff_secs)).await;
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }
    });
}

fn resolve_spec(app: &tauri::AppHandle) -> Option<ConnSpec> {
    use tauri::Manager;
    let state = app.try_state::<AgentState>()?;
    let guard = state.config.lock().ok()?;
    ConnSpec::from_config(&guard)
}

async fn run_one_connection(_app: &tauri::AppHandle, spec: &ConnSpec) -> Result<()> {
    // The Node.js panel on :5000 commonly redirects to :5443 (HTTPS). We
    // probe a small ranked list of scheme/port combinations, honouring any
    // explicit `BETTERDESK_CONSOLE_URL` override first.
    let candidates = candidate_urls(&spec.server_address, &spec.device_id, &spec.auth_token).await;

    let mut last_err: Option<String> = None;
    let mut stream: Option<WsStream> = None;
    for url in &candidates {
        match try_connect(url).await {
            Ok(s) => {
                info!("[bd-signal] Connected via {}", redact_token(url));
                stream = Some(s);
                break;
            }
            Err(e) => {
                debug!("[bd-signal] candidate failed: {} ({})", redact_token(url), e);
                last_err = Some(format!("{} -> {}", redact_token(url), e));
            }
        }
    }

    let ws_stream = match stream {
        Some(s) => s,
        None => {
            return Err(anyhow!(
                "bd-signal connect failed — last: {}",
                last_err.unwrap_or_else(|| "no candidates".into())
            ))
        }
    };

    let (mut write, mut read) = ws_stream.split();

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => return Err(anyhow!("WS read error: {}", e)),
        };

        let text = match msg {
            WsMessage::Text(t) => t,
            WsMessage::Ping(p) => {
                write.send(WsMessage::Pong(p)).await.ok();
                continue;
            }
            WsMessage::Close(_) => {
                info!("[bd-signal] Server closed connection");
                return Ok(());
            }
            _ => continue,
        };

        let envelope: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                debug!("[bd-signal] Skipping malformed frame: {}", e);
                continue;
            }
        };

        let kind = envelope.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Welcome / heartbeat_ack / unknown server-initiated frames — ignore.
        if kind == "welcome" || kind == "heartbeat_ack" || kind == "relay_ready" {
            continue;
        }

        let request_id = envelope
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);

        if request_id.is_empty() {
            debug!("[bd-signal] Skipping non-request frame: type={}", kind);
            continue;
        }

        let spec_clone = spec.clone();
        let kind_owned = kind.to_string();

        // Dispatch on a blocking task — most handlers shell out / read disk.
        let result = tokio::task::spawn_blocking(move || dispatch(&kind_owned, &payload, &spec_clone))
            .await
            .unwrap_or_else(|e| Err(anyhow!("Handler panicked: {}", e)));

        let response = match result {
            Ok(data) => json!({
                "type": "command_response",
                "request_id": request_id,
                "ok": true,
                "data": data,
            }),
            Err(e) => json!({
                "type": "command_response",
                "request_id": request_id,
                "ok": false,
                "error": e.to_string(),
            }),
        };

        if let Err(e) = write.send(WsMessage::Text(response.to_string())).await {
            return Err(anyhow!("Failed to send response: {}", e));
        }
    }

    Ok(())
}

/// Discover candidate WS URLs. Order: explicit override → discovered via
/// HTTP probe → scheme/port permutations.
async fn candidate_urls(server_address: &str, device_id: &str, token: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    if let Ok(forced) = std::env::var("BETTERDESK_CONSOLE_URL") {
        if !forced.trim().is_empty() {
            out.push(format_ws(&forced, device_id, token));
        }
    }

    // Probe http://host:5000 — if it redirects, follow to the real origin.
    if let Some(discovered) = probe_panel_origin(server_address).await {
        out.push(format_ws(&discovered, device_id, token));
    }

    let host = extract_host(server_address);
    let console_port = std::env::var("BETTERDESK_CONSOLE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(5000);
    for (scheme, port) in [
        ("wss", 5443u16),
        ("ws", console_port),
        ("wss", console_port),
        ("ws", 5443),
    ] {
        let url = format!(
            "{}://{}:{}/ws/bd-signal?device_id={}&token={}",
            scheme,
            host,
            port,
            urlencoding_encode(device_id),
            urlencoding_encode(token),
        );
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

fn format_ws(origin: &str, device_id: &str, token: &str) -> String {
    let o = origin.trim().trim_end_matches('/');
    let o = if o.starts_with("http://") {
        format!("ws://{}", &o[7..])
    } else if o.starts_with("https://") {
        format!("wss://{}", &o[8..])
    } else if o.starts_with("ws://") || o.starts_with("wss://") {
        o.to_string()
    } else {
        format!("ws://{}", o)
    };
    format!(
        "{}/ws/bd-signal?device_id={}&token={}",
        o,
        urlencoding_encode(device_id),
        urlencoding_encode(token),
    )
}

fn extract_host(server_address: &str) -> String {
    let with_scheme = if server_address.starts_with("http://") || server_address.starts_with("https://") {
        server_address.to_string()
    } else {
        format!("http://{}", server_address)
    };
    url::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_else(|| server_address.split(':').next().unwrap_or(server_address).to_string())
}

/// One-shot probe of `http://host:5000/` following a single redirect hop —
/// returns the final origin (scheme://host:port) on success.
async fn probe_panel_origin(server_address: &str) -> Option<String> {
    let host = extract_host(server_address);
    let probe = format!("http://{}:5000/", host);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let resp = client.get(&probe).send().await.ok()?;
    if resp.status().is_redirection() {
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
            if let Ok(loc_str) = loc.to_str() {
                if let Ok(parsed) = url::Url::parse(loc_str) {
                    let scheme = parsed.scheme();
                    let h = parsed.host_str().unwrap_or(&host);
                    let p = parsed.port().unwrap_or(if scheme == "https" { 443 } else { 80 });
                    return Some(format!("{}://{}:{}", scheme, h, p));
                }
            }
        }
    } else if resp.status().is_success() {
        return Some(format!("http://{}:5000", host));
    }
    None
}

fn redact_token(url: &str) -> String {
    if let Some(idx) = url.find("token=") {
        let mut out = url[..idx + 6].to_string();
        out.push_str("***");
        out
    } else {
        url.to_string()
    }
}

#[allow(dead_code)]
fn scheme_of(url: &str) -> &'static str {
    if url.starts_with("wss://") {
        "wss"
    } else {
        "ws"
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn try_connect(url: &str) -> Result<WsStream> {
    info!("[bd-signal] Trying {}", redact_token(url));
    let allow_invalid = std::env::var("BETTERDESK_STRICT_TLS").as_deref() != Ok("1");
    let connector = if url.starts_with("wss://") && allow_invalid {
        let tls = NativeTlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .context("Failed to build TLS connector")?;
        Some(tokio_tungstenite::Connector::NativeTls(tls))
    } else {
        None
    };

    let (ws, _resp) = if connector.is_some() {
        connect_async_tls_with_config(url, None, false, connector).await?
    } else {
        tokio_tungstenite::connect_async(url).await?
    };
    Ok(ws)
}

// ───────────────────────── Dispatcher ─────────────────────────

fn dispatch(kind: &str, payload: &Value, spec: &ConnSpec) -> Result<Value> {
    match kind {
        "services.list" => services_list(),
        "processes.list" => processes_list(),
        "events.list" => {
            let limit = payload
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(100)
                .min(500) as usize;
            events_list(limit)
        }
        "activity.get" => Ok(json!({ "apps": [] })),
        "files.browse" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let show_hidden = payload
                .get("show_hidden")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            files_browse(path, show_hidden)
        }
        "files.read" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let offset = payload.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let length = payload
                .get("length")
                .and_then(|v| v.as_u64())
                .unwrap_or(65536)
                .min(1024 * 1024);
            files_read(path, offset, length as usize)
        }
        "files.write" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let data_b64 = payload.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let mode = payload.get("mode").and_then(|v| v.as_str()).unwrap_or("overwrite");
            files_write(path, data_b64, mode)
        }
        "files.delete" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let recursive = payload
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            files_delete(path, recursive)
        }
        "files.rename" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let from = payload.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to = payload.get("to").and_then(|v| v.as_str()).unwrap_or("");
            files_rename(from, to)
        }
        "files.mkdir" => {
            require(spec.allow_file_browser, "file_browser_disabled")?;
            let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let recursive = payload
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            files_mkdir(path, recursive)
        }
        "clipboard.get" => {
            require(spec.allow_clipboard, "clipboard_disabled")?;
            clipboard_get()
        }
        "clipboard.set" => {
            require(spec.allow_clipboard, "clipboard_disabled")?;
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
            clipboard_set(text)
        }
        "screenshot.capture" => {
            require(spec.allow_screen_capture, "screen_capture_disabled")?;
            screenshot_capture()
        }
        "input.mouse" => {
            require(spec.allow_screen_capture, "input_disabled")?;
            input_mouse(payload)
        }
        "input.key" => {
            require(spec.allow_screen_capture, "input_disabled")?;
            input_key(payload)
        }
        "input.text" => {
            require(spec.allow_screen_capture, "input_disabled")?;
            input_text(payload)
        }
        "terminal.execute" => {
            require(spec.allow_terminal, "terminal_disabled")?;
            let cmd = payload.get("command").and_then(|v| v.as_str()).unwrap_or("");
            terminal_execute(cmd)
        }
        other => Err(anyhow!("unknown_command: {}", other)),
    }
}

fn require(flag: bool, err: &'static str) -> Result<()> {
    if flag {
        Ok(())
    } else {
        Err(anyhow!(err))
    }
}

// ───────────────────────── Handlers — services ─────────────────────────

#[derive(Serialize)]
struct ServiceItem {
    name: String,
    display_name: String,
    status: String,
    start_type: String,
}

fn services_list() -> Result<Value> {
    let items = collect_services()?;
    Ok(json!({ "services": items }))
}

#[cfg(target_os = "linux")]
fn collect_services() -> Result<Vec<ServiceItem>> {
    let out = std::process::Command::new("systemctl")
        .args([
            "list-units",
            "--type=service",
            "--all",
            "--no-pager",
            "--no-legend",
            "--plain",
        ])
        .output()
        .map_err(|e| anyhow!("systemctl unavailable: {}", e))?;

    if !out.status.success() {
        return Err(anyhow!(
            "systemctl exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut items = Vec::new();
    for line in text.lines() {
        // Format: UNIT LOAD ACTIVE SUB DESCRIPTION...
        let mut parts = line.split_whitespace();
        let name = parts.next().unwrap_or("").to_string();
        let _load = parts.next().unwrap_or("");
        let active = parts.next().unwrap_or("");
        let sub = parts.next().unwrap_or("");
        let description: String = parts.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        let status = if active == "active" && sub == "running" {
            "running"
        } else if active == "active" {
            "active"
        } else if active == "failed" {
            "failed"
        } else {
            "stopped"
        }
        .to_string();

        items.push(ServiceItem {
            name: name.clone(),
            display_name: if description.is_empty() { name } else { description },
            status,
            start_type: "-".into(),
        });
    }

    Ok(items)
}

#[cfg(target_os = "windows")]
fn collect_services() -> Result<Vec<ServiceItem>> {
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|e| anyhow!("powershell unavailable: {}", e))?;

    if !out.status.success() {
        return Err(anyhow!(
            "powershell exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let json: Value = serde_json::from_str(&text)
        .or_else(|_| serde_json::from_str(&format!("[{}]", text)))
        .unwrap_or(Value::Null);

    let arr = match json {
        Value::Array(a) => a,
        Value::Object(_) => vec![json],
        _ => Vec::new(),
    };

    let items = arr
        .into_iter()
        .map(|v| ServiceItem {
            name: v.get("Name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            display_name: v.get("DisplayName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            status: match v.get("Status").and_then(|x| x.as_i64()).unwrap_or(-1) {
                4 => "running".to_string(),
                1 => "stopped".to_string(),
                _ => v
                    .get("Status")
                    .and_then(|x| x.as_str())
                    .unwrap_or("-")
                    .to_lowercase(),
            },
            start_type: v
                .get("StartType")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("StartType").and_then(|x| x.as_i64()).map(|_| "-"))
                .unwrap_or("-")
                .to_string(),
        })
        .collect();

    Ok(items)
}

#[cfg(target_os = "macos")]
fn collect_services() -> Result<Vec<ServiceItem>> {
    let out = std::process::Command::new("launchctl")
        .args(["list"])
        .output()
        .map_err(|e| anyhow!("launchctl unavailable: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut items = Vec::new();
    // Header: PID Status Label
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            continue;
        }
        let mut parts = line.split_whitespace();
        let pid = parts.next().unwrap_or("-");
        let _status = parts.next().unwrap_or("-");
        let label = parts.collect::<Vec<_>>().join(" ");
        if label.is_empty() {
            continue;
        }
        items.push(ServiceItem {
            name: label.clone(),
            display_name: label,
            status: if pid == "-" {
                "stopped".into()
            } else {
                "running".into()
            },
            start_type: "-".into(),
        });
    }
    Ok(items)
}

// ───────────────────────── Handlers — processes ─────────────────────────

fn processes_list() -> Result<Value> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // Re-sample CPU (sysinfo requires two samples for usable CPU%).
    std::thread::sleep(Duration::from_millis(150));
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut out: Vec<Value> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            let mem_mb = p.memory() as f64 / (1024.0 * 1024.0);
            json!({
                "pid": pid.as_u32(),
                "name": p.name().to_string_lossy(),
                "user": p
                    .user_id()
                    .map(|u| u.to_string())
                    .unwrap_or_else(|| "-".into()),
                "cpu": p.cpu_usage(),
                "memory_mb": mem_mb,
            })
        })
        .collect();

    out.sort_by(|a, b| {
        let ca = a.get("cpu").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let cb = b.get("cpu").and_then(|v| v.as_f64()).unwrap_or(0.0);
        cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
    });

    out.truncate(300);
    Ok(json!({ "processes": out }))
}

// ───────────────────────── Handlers — events ─────────────────────────

#[cfg(target_os = "linux")]
fn events_list(limit: usize) -> Result<Value> {
    let n = limit.to_string();
    let out = std::process::Command::new("journalctl")
        .args([
            "-n", &n, "--no-pager", "-o", "short-iso",
            "--output-fields=__REALTIME_TIMESTAMP,_COMM,MESSAGE,PRIORITY",
        ])
        .output()
        .map_err(|e| anyhow!("journalctl unavailable: {}", e))?;

    let text = String::from_utf8_lossy(&out.stdout);
    let events: Vec<Value> = text
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with("--"))
        .map(|line| {
            // short-iso prefix: "2026-04-25T18:15:30+0000 host source[pid]: message"
            let (time_part, rest) = match line.find(' ') {
                Some(i) => (&line[..i], &line[i + 1..]),
                None => ("", line),
            };
            let (source, message) = match rest.find(": ") {
                Some(i) => {
                    let head = &rest[..i];
                    let comp = head.split_whitespace().last().unwrap_or(head);
                    (
                        comp.split('[').next().unwrap_or(comp).to_string(),
                        rest[i + 2..].to_string(),
                    )
                }
                None => ("-".to_string(), rest.to_string()),
            };
            let level = if message.to_lowercase().contains("error") || message.contains("ERR") {
                "error"
            } else if message.to_lowercase().contains("warn") {
                "warning"
            } else {
                "info"
            };
            json!({
                "time": time_part,
                "source": source,
                "message": message,
                "level": level,
            })
        })
        .collect();
    Ok(json!({ "events": events }))
}

#[cfg(target_os = "windows")]
fn events_list(limit: usize) -> Result<Value> {
    let cmd = format!(
        "Get-EventLog -LogName System -Newest {} | Select-Object @{{n='time';e={{$_.TimeGenerated.ToString('s')}}}}, @{{n='source';e={{$_.Source}}}}, @{{n='message';e={{$_.Message}}}}, @{{n='level';e={{$_.EntryType.ToString().ToLower()}}}} | ConvertTo-Json -Compress",
        limit.min(500)
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .output()
        .map_err(|e| anyhow!("powershell unavailable: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let json: Value = serde_json::from_str(&text)
        .or_else(|_| serde_json::from_str(&format!("[{}]", text)))
        .unwrap_or(Value::Null);
    let arr = match json {
        Value::Array(a) => a,
        Value::Object(_) => vec![json],
        _ => Vec::new(),
    };
    Ok(json!({ "events": arr }))
}

#[cfg(target_os = "macos")]
fn events_list(limit: usize) -> Result<Value> {
    let out = std::process::Command::new("log")
        .args(["show", "--last", "1h", "--style", "compact"])
        .output()
        .map_err(|e| anyhow!("log unavailable: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let events: Vec<Value> = text
        .lines()
        .take(limit)
        .map(|l| json!({ "time": "", "source": "system", "message": l, "level": "info" }))
        .collect();
    Ok(json!({ "events": events }))
}

// ───────────────────────── Handlers — files ─────────────────────────

fn safe_path(input: &str) -> Result<PathBuf> {
    let p = if input.is_empty() || input == "/" {
        #[cfg(target_os = "windows")]
        {
            PathBuf::from("C:\\")
        }
        #[cfg(not(target_os = "windows"))]
        {
            PathBuf::from("/")
        }
    } else {
        PathBuf::from(input)
    };
    // Reject ".." traversal at component level.
    for comp in p.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err(anyhow!("path_traversal_rejected"));
        }
    }
    Ok(p)
}

fn files_browse(path: &str, show_hidden: bool) -> Result<Value> {
    let target = safe_path(path)?;
    let canonical = target.canonicalize().unwrap_or(target.clone());

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "is_dir": meta.is_dir(),
            "size": if meta.is_file() { meta.len() } else { 0 },
        }));
    }

    // Sort: dirs first then alpha.
    entries.sort_by(|a, b| {
        let da = a.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        let db = b.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        match (da, db) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or("")),
        }
    });

    let parent = canonical
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| !p.is_empty() && *p != canonical.to_string_lossy());

    Ok(json!({
        "path": canonical.to_string_lossy(),
        "parent": parent,
        "entries": entries,
    }))
}

fn files_read(path: &str, offset: u64, length: usize) -> Result<Value> {
    use std::io::{Read, Seek, SeekFrom};
    let target = safe_path(path)?;
    let mut f = std::fs::File::open(&target)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; length];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(json!({
        "path": target.to_string_lossy(),
        "offset": offset,
        "length": n,
        "data": B64.encode(&buf),
    }))
}

/// Maximum size of a single `files.write` request to keep memory bounded.
const MAX_WRITE_BYTES: usize = 16 * 1024 * 1024; // 16 MB

fn files_write(path: &str, data_b64: &str, mode: &str) -> Result<Value> {
    use std::io::Write;
    if path.is_empty() {
        return Err(anyhow!("missing_path"));
    }
    let target = safe_path(path)?;
    let bytes = B64.decode(data_b64).map_err(|e| anyhow!("bad_base64: {}", e))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(anyhow!("payload_too_large"));
    }

    // Make sure the parent dir exists when creating a fresh file.
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| anyhow!("create_parent_failed: {}", e))?;
        }
    }

    let mut opts = std::fs::OpenOptions::new();
    match mode {
        "append" => {
            opts.create(true).append(true);
        }
        "create" => {
            opts.create_new(true).write(true);
        }
        // default — overwrite
        _ => {
            opts.create(true).write(true).truncate(true);
        }
    }
    let mut f = opts
        .open(&target)
        .map_err(|e| anyhow!("open_failed: {}", e))?;
    f.write_all(&bytes)
        .map_err(|e| anyhow!("write_failed: {}", e))?;
    f.flush().ok();

    Ok(json!({
        "path": target.to_string_lossy(),
        "bytes": bytes.len(),
        "mode": mode,
    }))
}

fn files_delete(path: &str, recursive: bool) -> Result<Value> {
    if path.is_empty() {
        return Err(anyhow!("missing_path"));
    }
    let target = safe_path(path)?;
    let meta = std::fs::symlink_metadata(&target)
        .map_err(|e| anyhow!("stat_failed: {}", e))?;
    let kind = if meta.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&target).map_err(|e| anyhow!("rmdir_failed: {}", e))?;
        } else {
            std::fs::remove_dir(&target).map_err(|e| anyhow!("rmdir_failed: {}", e))?;
        }
        "dir"
    } else {
        std::fs::remove_file(&target).map_err(|e| anyhow!("unlink_failed: {}", e))?;
        "file"
    };
    Ok(json!({
        "path": target.to_string_lossy(),
        "kind": kind,
        "recursive": recursive,
    }))
}

fn files_rename(from: &str, to: &str) -> Result<Value> {
    if from.is_empty() || to.is_empty() {
        return Err(anyhow!("missing_path"));
    }
    let src = safe_path(from)?;
    let dst = safe_path(to)?;
    if !src.exists() {
        return Err(anyhow!("source_not_found"));
    }
    // Ensure destination parent exists.
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| anyhow!("create_parent_failed: {}", e))?;
        }
    }
    std::fs::rename(&src, &dst).map_err(|e| anyhow!("rename_failed: {}", e))?;
    Ok(json!({
        "from": src.to_string_lossy(),
        "to": dst.to_string_lossy(),
    }))
}

fn files_mkdir(path: &str, recursive: bool) -> Result<Value> {
    if path.is_empty() {
        return Err(anyhow!("missing_path"));
    }
    let target = safe_path(path)?;
    if target.exists() {
        return Err(anyhow!("already_exists"));
    }
    if recursive {
        std::fs::create_dir_all(&target).map_err(|e| anyhow!("mkdir_failed: {}", e))?;
    } else {
        std::fs::create_dir(&target).map_err(|e| anyhow!("mkdir_failed: {}", e))?;
    }
    Ok(json!({
        "path": target.to_string_lossy(),
        "recursive": recursive,
    }))
}

// ───────────────────────── Handlers — clipboard (Phase 64) ─────────────────────────

fn clipboard_get() -> Result<Value> {
    let mut cb = arboard::Clipboard::new()
        .map_err(|e| anyhow!("clipboard_init_failed: {}", e))?;
    match cb.get_text() {
        Ok(text) => Ok(json!({
            "format": "text",
            "text": text,
            "length": text.len(),
        })),
        Err(arboard::Error::ContentNotAvailable) => Ok(json!({
            "format": "text",
            "text": "",
            "empty": true,
        })),
        Err(e) => Err(anyhow!("clipboard_read_failed: {}", e)),
    }
}

fn clipboard_set(text: &str) -> Result<Value> {
    if text.len() > 1024 * 1024 {
        return Err(anyhow!("text_too_large"));
    }
    let mut cb = arboard::Clipboard::new()
        .map_err(|e| anyhow!("clipboard_init_failed: {}", e))?;
    cb.set_text(text.to_string())
        .map_err(|e| anyhow!("clipboard_write_failed: {}", e))?;
    Ok(json!({
        "ok": true,
        "length": text.len(),
    }))
}

// ───────────────────────── Handlers — screenshot ─────────────────────────

fn screenshot_capture() -> Result<Value> {
    let tmp = std::env::temp_dir().join(format!(
        "bd-screenshot-{}.jpg",
        uuid::Uuid::new_v4().simple()
    ));
    capture_to_file(&tmp)?;
    let bytes = std::fs::read(&tmp).map_err(|e| anyhow!("read screenshot: {}", e))?;
    let _ = std::fs::remove_file(&tmp);
    let (width, height) = match image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
    {
        Ok(img) => (img.width() as u64, img.height() as u64),
        Err(_) => (0, 0),
    };
    Ok(json!({
        "format": "jpeg",
        "image": B64.encode(&bytes),
        "size": bytes.len(),
        "width": width,
        "height": height,
    }))
}

#[cfg(target_os = "linux")]
fn capture_to_file(path: &Path) -> Result<()> {
    // Prefer tools that match the active desktop session. On KDE Plasma
    // Wayland, Spectacle works reliably while ImageMagick `import` does not.
    let path_str = path.to_string_lossy().to_string();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok().filter(|v| !v.is_empty()).is_some();
    let plasma = std::env::var("XDG_SESSION_DESKTOP")
        .ok()
        .or_else(|| std::env::var("DESKTOP_SESSION").ok())
        .map(|v| v.to_ascii_lowercase())
        .map(|v| v.contains("plasma") || v.contains("kde"))
        .unwrap_or(false);

    let attempts: Vec<(&str, Vec<&str>)> = if wayland && plasma {
        vec![
            ("spectacle", vec!["-b", "-n", "-o", &path_str]),
            ("grim", vec![&path_str]),
            ("gnome-screenshot", vec!["-f", &path_str]),
            ("scrot", vec!["-z", &path_str]),
            ("import", vec!["-window", "root", &path_str]),
        ]
    } else if wayland {
        vec![
            ("grim", vec![&path_str]),
            ("gnome-screenshot", vec!["-f", &path_str]),
            ("spectacle", vec!["-b", "-n", "-o", &path_str]),
            ("scrot", vec!["-z", &path_str]),
            ("import", vec!["-window", "root", &path_str]),
        ]
    } else {
        vec![
            ("scrot", vec!["-z", &path_str]),
            ("import", vec!["-window", "root", &path_str]),
            ("gnome-screenshot", vec!["-f", &path_str]),
            ("spectacle", vec!["-b", "-n", "-o", &path_str]),
            ("grim", vec![&path_str]),
        ]
    };

    let mut last_err = String::new();
    for (bin, args) in attempts {
        match std::process::Command::new(bin).args(&args).output() {
            Ok(out) if out.status.success() && path.exists() => return Ok(()),
            Ok(out) => {
                last_err = format!(
                    "{} exit {}: {}",
                    bin,
                    out.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(e) => {
                last_err = format!("{}: {}", bin, e);
            }
        }
    }
    Err(anyhow!("no_screenshot_tool: {}", last_err))
}

#[cfg(target_os = "macos")]
fn capture_to_file(path: &Path) -> Result<()> {
    let out = std::process::Command::new("screencapture")
        .args(["-x", "-t", "jpg", &path.to_string_lossy()])
        .output()
        .map_err(|e| anyhow!("screencapture unavailable: {}", e))?;
    if !out.status.success() {
        return Err(anyhow!("screencapture failed"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_to_file(path: &Path) -> Result<()> {
    let p = path.to_string_lossy().replace('\\', "\\\\");
    let ps = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
        $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height);
        $g = [System.Drawing.Graphics]::FromImage($bmp);
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
        $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Jpeg);"#,
        p
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()
        .map_err(|e| anyhow!("powershell unavailable: {}", e))?;
    if !out.status.success() {
        return Err(anyhow!(
            "screenshot ps failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// ───────────────────────── Handlers — input injection (Phase 58) ─────────────────────────

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::{Mutex, OnceLock};

fn enigo_handle() -> Result<&'static Mutex<Enigo>> {
    static ENIGO: OnceLock<Mutex<Enigo>> = OnceLock::new();
    if let Some(e) = ENIGO.get() {
        return Ok(e);
    }
    let inst = Enigo::new(&Settings::default())
        .map_err(|e| anyhow!("enigo_init_failed: {}", e))?;
    let _ = ENIGO.set(Mutex::new(inst));
    ENIGO
        .get()
        .ok_or_else(|| anyhow!("enigo_init_race"))
}

fn input_mouse(payload: &Value) -> Result<Value> {
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("move");
    let handle = enigo_handle()?;
    let mut enigo = handle.lock().map_err(|_| anyhow!("enigo_poisoned"))?;

    match action {
        "move" => {
            let (x, y) = resolve_coords(&mut enigo, payload)?;
            enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| anyhow!("move_failed: {}", e))?;
        }
        "down" | "up" | "click" => {
            // Move first if coordinates are provided alongside the click.
            if payload.get("x").is_some() || payload.get("x_rel").is_some() {
                if let Ok((x, y)) = resolve_coords(&mut enigo, payload) {
                    let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                }
            }
            let button = parse_button(payload);
            let dir = match action {
                "down" => Direction::Press,
                "up" => Direction::Release,
                _ => Direction::Click,
            };
            enigo
                .button(button, dir)
                .map_err(|e| anyhow!("button_failed: {}", e))?;
        }
        "wheel" => {
            let dy = payload.get("wheel_dy").and_then(|v| v.as_i64()).unwrap_or(0);
            let dx = payload.get("wheel_dx").and_then(|v| v.as_i64()).unwrap_or(0);
            if dy != 0 {
                enigo
                    .scroll(dy as i32, Axis::Vertical)
                    .map_err(|e| anyhow!("scroll_failed: {}", e))?;
            }
            if dx != 0 {
                enigo
                    .scroll(dx as i32, Axis::Horizontal)
                    .map_err(|e| anyhow!("scroll_failed: {}", e))?;
            }
        }
        other => return Err(anyhow!("unknown_mouse_action: {}", other)),
    }
    Ok(json!({ "ok": true }))
}

/// Resolve absolute pixel coords from either `x`/`y` (px) or `x_rel`/`y_rel` (0..1 of `screen_w`/`screen_h`).
fn resolve_coords(enigo: &mut Enigo, payload: &Value) -> Result<(i32, i32)> {
    if let (Some(x), Some(y)) = (
        payload.get("x").and_then(|v| v.as_i64()),
        payload.get("y").and_then(|v| v.as_i64()),
    ) {
        return Ok((x as i32, y as i32));
    }
    let xr = payload
        .get("x_rel")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow!("missing_coords"))?;
    let yr = payload
        .get("y_rel")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow!("missing_coords"))?;
    // Prefer caller-supplied screen dims (from latest screenshot); fall back to Enigo main display.
    let (sw, sh) = match (
        payload.get("screen_w").and_then(|v| v.as_u64()),
        payload.get("screen_h").and_then(|v| v.as_u64()),
    ) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w as i32, h as i32),
        _ => enigo
            .main_display()
            .map_err(|e| anyhow!("display_failed: {}", e))?,
    };
    let xr = xr.clamp(0.0, 1.0);
    let yr = yr.clamp(0.0, 1.0);
    Ok((((xr * sw as f64) as i32), ((yr * sh as f64) as i32)))
}

fn parse_button(payload: &Value) -> Button {
    match payload.get("button").and_then(|v| v.as_str()).unwrap_or("left") {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

fn input_key(payload: &Value) -> Result<Value> {
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("press");
    let key_str = payload
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing_key"))?;

    let dir = match action {
        "down" => Direction::Press,
        "up" => Direction::Release,
        _ => Direction::Click,
    };

    let key = map_key(key_str)?;
    let handle = enigo_handle()?;
    let mut enigo = handle.lock().map_err(|_| anyhow!("enigo_poisoned"))?;
    enigo
        .key(key, dir)
        .map_err(|e| anyhow!("key_failed: {}", e))?;
    Ok(json!({ "ok": true }))
}

fn input_text(payload: &Value) -> Result<Value> {
    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing_text"))?;
    if text.is_empty() {
        return Ok(json!({ "ok": true, "skipped": true }));
    }
    if text.len() > 4096 {
        return Err(anyhow!("text_too_long"));
    }
    let handle = enigo_handle()?;
    let mut enigo = handle.lock().map_err(|_| anyhow!("enigo_poisoned"))?;
    enigo
        .text(text)
        .map_err(|e| anyhow!("text_failed: {}", e))?;
    Ok(json!({ "ok": true }))
}

fn map_key(s: &str) -> Result<Key> {
    // Match common DOM `KeyboardEvent.key` / `code` values.
    let k = match s {
        "Enter" | "Return" => Key::Return,
        "Escape" | "Esc" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        " " | "Space" | "Spacebar" => Key::Space,
        "ArrowUp" | "Up" => Key::UpArrow,
        "ArrowDown" | "Down" => Key::DownArrow,
        "ArrowLeft" | "Left" => Key::LeftArrow,
        "ArrowRight" | "Right" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Delete" | "Del" => Key::Delete,
        "Insert" => Key::Insert,
        "CapsLock" => Key::CapsLock,
        "Shift" | "ShiftLeft" | "ShiftRight" => Key::Shift,
        "Control" | "ControlLeft" | "ControlRight" | "Ctrl" => Key::Control,
        "Alt" | "AltLeft" | "AltRight" => Key::Alt,
        "Meta" | "MetaLeft" | "MetaRight" | "OS" | "Super" => Key::Meta,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        other if other.chars().count() == 1 => {
            let c = other.chars().next().unwrap();
            Key::Unicode(c)
        }
        other => return Err(anyhow!("unknown_key: {}", other)),
    };
    Ok(k)
}

// ───────────────────────── Handlers — terminal ─────────────────────────

fn terminal_execute(command: &str) -> Result<Value> {
    if command.trim().is_empty() {
        return Err(anyhow!("empty_command"));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd.exe");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    let out = cmd.output().map_err(|e| anyhow!("spawn failed: {}", e))?;
    Ok(json!({
        "exit_code": out.status.code().unwrap_or(-1),
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_https_origin() {
        let u = build_ws_url("https://example.com:21114", "BD-X", "tok");
        assert_eq!(u, "wss://example.com:5000/ws/bd-signal?device_id=BD-X&token=tok");
    }

    #[test]
    fn ws_url_http_origin() {
        let u = build_ws_url("http://192.168.1.10", "BD-Y", "t k");
        assert_eq!(
            u,
            "ws://192.168.1.10:5000/ws/bd-signal?device_id=BD-Y&token=t%20k"
        );
    }

    #[test]
    fn safe_path_rejects_dotdot() {
        assert!(safe_path("/home/../etc").is_err());
        assert!(safe_path("/home/user").is_ok());
    }
}
