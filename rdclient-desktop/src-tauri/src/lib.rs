mod config;
mod discovery;
mod desktop_clipboard;
mod desktop_files;
mod server_probe;

#[cfg(target_os = "linux")]
pub mod linux_display;
pub mod tls_policy;

use config::{
    apply_tls_from_config, clear_config, env_server_url, load_config, load_embedded_server_url,
    save_config, AppConfig,
};
use desktop_clipboard::{
    desktop_clipboard_clear, desktop_clipboard_file_contents, desktop_clipboard_format_data,
    desktop_clipboard_format_names, desktop_clipboard_receive_abort,
    desktop_clipboard_receive_begin, desktop_clipboard_receive_commit,
    desktop_clipboard_receive_write, desktop_clipboard_sync, desktop_clipboard_sync_paths,
};
use desktop_files::{
    desktop_list_directory, desktop_open_file, desktop_open_paths, desktop_pick_files,
    desktop_pick_folder, desktop_read_file_chunk, desktop_release_file_handles,
    desktop_save_download, DesktopFileStore,
};
use discovery::discover_udp;
use server_probe::probe_panel_url;
use tls_policy::apply_window_builder;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_utils::config::BackgroundThrottlingPolicy;

const MAIN_LABEL: &str = "main";
const SETTINGS_LABEL: &str = "settings";
const CLIENT_BUILD: &str = "0.1.0-production";

/// Injected before page JS — desktop flag + Connect bridge (works even if panel JS is older).
const DESKTOP_INIT_SCRIPT: &str = r#"
window.__BETTERDESK_RDCLIENT_DESKTOP__=true;
(function(){
  function syncVh(){var h=window.innerHeight;if(h<1)return;document.documentElement.style.setProperty('--rd-desk-vh',h+'px');}
  function mark(){document.documentElement.classList.add('rd-desk-desktop');if(document.body)document.body.classList.add('rd-desk-desktop');var a=document.getElementById('rd-desk-app');if(a)a.classList.add('rd-desk-desktop');syncVh();if(!window.__rdDeskViewportBound){window.__rdDeskViewportBound=true;window.addEventListener('resize',syncVh);}}
  syncVh();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mark,{once:true});else mark();
})();
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
(function(){
  if(document.cookie.indexOf('betterdesk_lang=')>=0)return;
  var inv=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
  if(!inv)return;
  inv('get_config').then(function(cfg){
    var pref=cfg&&cfg.ui_lang;
    if(pref){document.cookie='betterdesk_lang='+encodeURIComponent(pref)+';path=/;max-age=31536000';return;}
    return inv('get_system_locale').then(function(locale){
      if(!locale)return;
      var code=String(locale).split(/[-_]/)[0].toLowerCase();
      if(!code)return;
      return fetch('/api/i18n/set/'+encodeURIComponent(code),{method:'POST',credentials:'include',headers:{'X-Requested-With':'XMLHttpRequest'}});
    });
  }).catch(function(){});
})();
(function(){
  function bindNativeDrop(){
    var ev=window.__TAURI__&&window.__TAURI__.event;
    if(!ev||typeof ev.listen!=='function'||window.__rdDeskNativeDropBound)return;
    window.__rdDeskNativeDropBound=true;
    function emitDrop(paths,position){
      if(!paths||!paths.length)return;
      window.dispatchEvent(new CustomEvent('rd-desk-native-drop',{detail:{paths:paths,position:position||null}}));
    }
    ev.listen('tauri://drag-drop',function(e){
      var p=e&&e.payload?e.payload:{};
      emitDrop(p.paths||[],p.position||null);
    }).catch(function(){window.__rdDeskNativeDropBound=false;});
  }
  bindNativeDrop();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindNativeDrop,{once:true});
  else setTimeout(bindNativeDrop,0);
})();
"#;

const PANEL_INVOKE_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:event:allow-listen",
    "core:window:allow-create",
    "core:window:allow-set-focus",
    "core:window:allow-close",
    "core:webview:allow-create-webview-window",
    "core:webview:allow-clear-all-browsing-data",
    "shell:allow-open",
    "allow-get-client-info",
    "allow-get-server-url",
    "allow-set-server-url",
    "allow-probe-server-url",
    "allow-discover-servers",
    "allow-get-config",
    "allow-set-tls-strict",
    "allow-set-ui-lang",
    "allow-open-settings",
    "allow-sign-out",
    "allow-reset-client",
    "allow-get-system-locale",
    "allow-open-session",
    "allow-close-current-window",
    "allow-desktop-pick-files",
    "allow-desktop-open-file",
    "allow-desktop-read-file-chunk",
    "allow-desktop-release-file-handles",
    "allow-desktop-pick-folder",
    "allow-desktop-list-directory",
    "allow-desktop-save-download",
    "allow-desktop-clipboard-sync",
    "allow-desktop-clipboard-format-data",
    "allow-desktop-clipboard-file-contents",
    "allow-desktop-clipboard-clear",
    "allow-desktop-clipboard-format-names",
    "allow-desktop-clipboard-sync-paths",
    "allow-desktop-clipboard-receive-begin",
    "allow-desktop-clipboard-receive-write",
    "allow-desktop-clipboard-receive-commit",
    "allow-desktop-clipboard-receive-abort",
    "allow-desktop-open-paths",
];

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
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

    url::parse_helper(&with_scheme)
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
        .window(SETTINGS_LABEL)
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

/// Shared WebView2 options for every window in this process.
///
/// On Windows, secondary webviews must use the same `CoreWebView2EnvironmentOptions`
/// as the first webview when they share a user-data folder; mismatched browser args
/// leave new windows stuck on a blank white surface.
///
/// `enable_clipboard_access` is required for `navigator.clipboard` (local ↔ remote text
/// sync and the toolbar Paste action). Keep Tauri's native drag-drop handler enabled so
/// OS file drops deliver real filesystem paths (HTML5 drops alone are unusable in WebView2).
fn apply_webview_window<R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    apply_window_builder(
        builder
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .enable_clipboard_access(),
    )
}

fn apply_desktop_window<R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    apply_webview_window(builder.initialization_script(DESKTOP_INIT_SCRIPT))
}

fn close_session_windows(app: &AppHandle) {
    for label in app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("session-"))
        .cloned()
        .collect::<Vec<_>>()
    {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
}

fn clear_all_webview_data(app: &AppHandle) -> Result<(), String> {
    for (_label, window) in app.webview_windows() {
        window
            .clear_all_browsing_data()
            .map_err(|e| format!("Failed to clear browsing data: {e}"))?;
    }
    Ok(())
}

async fn save_server_url(app: &AppHandle, url: String, via: Option<&str>) -> Result<(), String> {
    let cfg = load_config(app)?;
    let result = probe_panel_url(&url, cfg.tls_strict).await;
    if !result.ok {
        return Err(
            result
                .error
                .unwrap_or_else(|| "Server did not respond as a BetterDesk panel".into()),
        );
    }

    let normalized = result.normalized_url;
    register_panel_remote_capability(app, &normalized)?;
    let mut cfg = load_config(app)?;
    cfg.server_url = Some(normalized.clone());
    if let Some(source) = via {
        cfg.discovered_via = Some(source.to_string());
    }
    save_config(app, &cfg)?;
    open_main_window(app, WebviewUrl::External(dashboard_url(&normalized)?))?;
    Ok(())
}

fn open_main_window(app: &AppHandle, url: WebviewUrl) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(MAIN_LABEL) {
        if let WebviewUrl::External(parsed) = url {
            existing.navigate(parsed).map_err(|e| e.to_string())?;
            existing.set_focus().map_err(|e| e.to_string())?;
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

fn try_auto_configure_server(app: &AppHandle) -> Result<bool, String> {
    let cfg = load_config(app)?;
    if cfg.server_url.is_some() {
        return Ok(false);
    }

    let candidate = match env_server_url().or_else(load_embedded_server_url) {
        Some(c) => c,
        None => return Ok(false),
    };

    let rt = tokio::runtime::Handle::current();
    let probe = rt.block_on(probe_panel_url(&candidate, cfg.tls_strict));
    if !probe.ok {
        return Ok(false);
    }

    register_panel_remote_capability(app, &probe.normalized_url)?;
    let mut updated = load_config(app)?;
    updated.server_url = Some(probe.normalized_url);
    updated.discovered_via = Some(
        if env_server_url().is_some() {
            "env"
        } else {
            "embedded"
        }
        .into(),
    );
    save_config(app, &updated)?;
    Ok(true)
}

fn launch_main(app: &AppHandle) -> Result<(), String> {
    let cfg = load_config(app)?;
    apply_tls_from_config(&cfg);

    let url = if cfg.server_url.is_some() {
        WebviewUrl::External(dashboard_url(cfg.server_url.as_ref().unwrap())?)
    } else if try_auto_configure_server(app)? {
        let updated = load_config(app)?;
        WebviewUrl::External(dashboard_url(updated.server_url.as_ref().unwrap())?)
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
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    load_config(&app)
}

#[tauri::command]
async fn probe_server_url(app: AppHandle, url: String) -> Result<server_probe::ServerProbeResult, String> {
    let cfg = load_config(&app)?;
    Ok(probe_panel_url(&url, cfg.tls_strict).await)
}

#[tauri::command]
fn discover_servers() -> Vec<discovery::DiscoveredServer> {
    discover_udp(2500)
}

#[tauri::command]
async fn set_server_url(app: AppHandle, url: String) -> Result<(), String> {
    save_server_url(&app, url, Some("manual")).await
}

#[tauri::command]
fn set_tls_strict(app: AppHandle, strict: bool) -> Result<(), String> {
    let mut cfg = load_config(&app)?;
    cfg.tls_strict = strict;
    save_config(&app, &cfg)?;
    if strict {
        unsafe {
            std::env::set_var("BETTERDESK_TLS_STRICT", "1");
        }
    } else {
        unsafe {
            std::env::remove_var("BETTERDESK_TLS_STRICT");
        }
    }
    Ok(())
}

#[tauri::command]
fn set_ui_lang(app: AppHandle, lang: Option<String>) -> Result<(), String> {
    let mut cfg = load_config(&app)?;
    cfg.ui_lang = lang.filter(|s| !s.trim().is_empty());
    save_config(&app, &cfg)
}

#[tauri::command]
fn get_system_locale() -> Option<String> {
    sys_locale::get_locale()
}


#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    apply_webview_window(
        WebviewWindowBuilder::new(
            &app,
            SETTINGS_LABEL,
            WebviewUrl::App("settings.html".into()),
        )
        .title("Settings")
        .inner_size(520.0, 680.0)
        .min_inner_size(400.0, 500.0),
    )
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}



#[tauri::command]
async fn sign_out(app: AppHandle) -> Result<(), String> {
    close_session_windows(&app);
    clear_all_webview_data(&app)?;

    let cfg = load_config(&app)?;
    if let Some(base) = cfg.server_url {
        open_main_window(
            &app,
            WebviewUrl::External(
                tauri::Url::parse(&format!("{}/remote/login", base.trim_end_matches('/')))
                    .map_err(|e| e.to_string())?,
            ),
        )?;
    }
    Ok(())
}

#[tauri::command]
async fn reset_client(app: AppHandle) -> Result<(), String> {
    close_session_windows(&app);
    clear_all_webview_data(&app)?;
    clear_config(&app)?;

    if let Some(settings) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = settings.close();
    }

    open_main_window(&app, WebviewUrl::App("setup.html".into()))?;
    Ok(())
}

#[tauri::command]
async fn open_session(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = request.body();
    let args: serde_json::Value = match body {
        tauri::ipc::InvokeBody::Json(json) => json.clone(),
        _ => serde_json::Value::Null,
    };

    let device_id = args
        .get("deviceId")
        .or_else(|| args.get("device_id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "deviceId is required".to_string())?
        .to_string();

    if !is_valid_device_id(&device_id) {
        return Err("Invalid device ID".into());
    }

    let title = args
        .get("deviceName")
        .or_else(|| args.get("device_name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&device_id)
        .to_string();

    let base = load_config(&app)?
        .server_url
        .ok_or_else(|| "Server URL is not configured".to_string())?;

    let label = session_label(&device_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::External(session_url(&base, &device_id)?);

    apply_desktop_window(
        WebviewWindowBuilder::new(&app, &label, url)
            .title(format!("Remote – {title}"))
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0),
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
        .manage(DesktopFileStore::default())
        .invoke_handler(tauri::generate_handler![
            get_client_info,
            get_server_url,
            get_config,
            probe_server_url,
            discover_servers,
            set_server_url,
            set_tls_strict,
            set_ui_lang,
            get_system_locale,
            open_settings,
            sign_out,
            reset_client,
            open_session,
            close_current_window,
            desktop_pick_files,
            desktop_open_file,
            desktop_read_file_chunk,
            desktop_release_file_handles,
            desktop_pick_folder,
            desktop_list_directory,
            desktop_save_download,
            desktop_clipboard_sync,
            desktop_clipboard_format_data,
            desktop_clipboard_file_contents,
            desktop_clipboard_clear,
            desktop_clipboard_format_names,
            desktop_clipboard_sync_paths,
            desktop_clipboard_receive_begin,
            desktop_clipboard_receive_write,
            desktop_clipboard_receive_commit,
            desktop_clipboard_receive_abort,
            desktop_open_paths,
        ])
        .setup(|app| {
            if let Some(base) = load_config(app.handle())?.server_url.clone() {
                register_panel_remote_capability(app.handle(), &base)?;
            }
            launch_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BetterDesk RdClient");
}
