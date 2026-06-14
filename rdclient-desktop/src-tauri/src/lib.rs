mod config;

#[cfg(target_os = "linux")]
pub mod linux_display;
pub mod tls_policy;

use config::{load_config, save_config};
use tls_policy::apply_window_builder;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_utils::config::BackgroundThrottlingPolicy;

const MAIN_LABEL: &str = "main";
const CLIENT_BUILD: &str = "0.1.0-connect-bridge";

/// Injected before page JS — desktop flag + Connect bridge (works even if panel JS is older).
const DESKTOP_INIT_SCRIPT: &str = r#"
window.__BETTERDESK_RDCLIENT_DESKTOP__=true;
(function(){function m(){document.documentElement.classList.add('rd-desk-desktop');if(document.body)document.body.classList.add('rd-desk-desktop');var a=document.getElementById('rd-desk-app');if(a)a.classList.add('rd-desk-desktop');}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',m,{once:true});else m();})();
function __rdDesktopInvoke(){return window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;}
function __rdIsSessionViewer(){return /\/remote\/[^/?#]+/.test(location.pathname);}
function __rdCloseWindow(){
  var invoke=__rdDesktopInvoke();
  if(!invoke)return;
  invoke('close_current_window').catch(function(){
    var w=window.__TAURI__&&window.__TAURI__.window&&window.__TAURI__.window.getCurrentWindow;
    if(w)w().close().catch(function(){});
  });
}
document.addEventListener('click',function(e){
  var back=e.target&&e.target.closest?e.target.closest('#btn-back-devices,.tab-bar-back'):null;
  if(back&&__rdIsSessionViewer()){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    __rdCloseWindow();
    return;
  }
  var t=e.target&&e.target.closest?e.target.closest('.rd-desk-card-connect,.rd-desk-connect,#rd-desk-quick-btn'):null;
  if(!t||t.disabled)return;
  var invoke=__rdDesktopInvoke();
  if(!invoke)return;
  if(t.id==='rd-desk-quick-btn'){
    var input=document.getElementById('rd-desk-quick-id');
    var id=input&&input.value?input.value.trim().replace(/\s/g,''):'';
    if(!id||!/^[A-Za-z0-9_-]{3,64}$/.test(id))return;
    e.preventDefault();e.stopPropagation();
    invoke('open_session',{deviceId:id,deviceName:id}).catch(function(err){
      alert(String(err&&err.message?err.message:err||'Connect failed'));
    });
    return;
  }
  if(t.matches('.rd-desk-card-connect,.rd-desk-connect')){
    var deviceId=t.getAttribute('data-id');
    if(!deviceId)return;
    e.preventDefault();e.stopPropagation();
    invoke('open_session',{deviceId:deviceId,deviceName:t.getAttribute('data-name')||''}).catch(function(err){
      alert(String(err&&err.message?err.message:err||'Connect failed'));
    });
  }
},true);
"#;

const PANEL_INVOKE_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:window:allow-create",
    "core:window:allow-set-focus",
    "core:window:allow-close",
    "core:webview:allow-create-webview-window",
    "shell:allow-open",
    "allow-get-server-url",
    "allow-set-server-url",
    "allow-open-session",
    "allow-close-current-window",
    "allow-get-client-info",
];

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

fn panel_remote_url_patterns(base: &str) -> Result<Vec<String>, String> {
    let parsed = Url::parse(base.trim_end_matches('/'))
        .map_err(|_| "Invalid server URL".to_string())?;
    let origin = parsed.origin().ascii_serialization();
    Ok(vec![origin.clone(), format!("{origin}/*")])
}

fn register_panel_remote_capability(app: &AppHandle, base: &str) -> Result<(), String> {
    let patterns = panel_remote_url_patterns(base)?;
    let mut builder = CapabilityBuilder::new("panel-operator")
        .local(true)
        .window(MAIN_LABEL)
        .window("session-*");

    for pattern in patterns {
        builder = builder.remote(pattern);
    }

    for permission in PANEL_INVOKE_PERMISSIONS {
        builder = builder.permission(*permission);
    }

    app.add_capability(builder)
        .map_err(|e| format!("Failed to register panel IPC capability: {e}"))
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

fn apply_desktop_window<R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    apply_window_builder(
        builder
            .initialization_script(DESKTOP_INIT_SCRIPT)
            .background_throttling(BackgroundThrottlingPolicy::Disabled),
    )
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

    apply_desktop_window(
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
fn get_client_info() -> serde_json::Value {
    serde_json::json!({
        "client": "rdclient-desktop",
        "build": CLIENT_BUILD,
    })
}

#[tauri::command]
fn get_server_url(app: AppHandle) -> Result<Option<String>, String> {
    Ok(load_config(&app)?.server_url)
}

#[tauri::command]
fn set_server_url(app: AppHandle, url: String) -> Result<(), String> {
    let normalized = normalize_server_url(&url)?;
    register_panel_remote_capability(&app, &normalized)?;
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

    apply_desktop_window(
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

#[tauri::command]
fn close_current_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tls_policy::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_client_info,
            get_server_url,
            set_server_url,
            open_session,
            close_current_window
        ])
        .setup(|app| {
            if let Some(base) = load_config(app.handle())?.server_url {
                register_panel_remote_capability(app.handle(), &base)?;
            }
            launch_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BetterDesk RdClient");
}
