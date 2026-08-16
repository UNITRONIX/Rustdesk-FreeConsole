//! TLS policy for operator panels (HTTP, self-signed, Let's Encrypt with incomplete chain).
//!
//! Linux: patched `wry` sets WebKit `TLSErrorsPolicy::Ignore` on each WebContext.
//! Windows: WebView2 flags via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` only.
//!
//! Do **not** call `WebviewWindowBuilder::additional_browser_args` for multi-window
//! apps on Windows — it deadlocks on the second window even with identical args
//! (tauri-apps/tauri#15014). Pass flags through the process env var instead so every
//! webview keeps wry's default `CoreWebView2EnvironmentOptions`.
//!
//! Set `BETTERDESK_TLS_STRICT=1` to use system certificate validation (production CA only).

use tauri::{Runtime, WebviewWindowBuilder};

const WEBVIEW2_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UseSurfaceLayerForVideo ",
    "--enable-gpu-rasterization ",
    "--enable-accelerated-video-decode ",
    "--enable-features=PlatformAV1VideoDecoder,PlatformHEVCDecoderSupport,VaapiVideoDecoder,WebCodecs ",
    "--autoplay-policy=no-user-gesture-required",
);

pub fn tls_strict() -> bool {
    std::env::var("BETTERDESK_TLS_STRICT")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

fn webview2_browser_args() -> String {
    if tls_strict() {
        WEBVIEW2_BROWSER_ARGS.to_string()
    } else {
        format!("--ignore-certificate-errors {WEBVIEW2_BROWSER_ARGS}")
    }
}

/// Call before `tauri::Builder::run` (Windows WebView2 environment).
pub fn init() {
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        // SAFETY: single-threaded before WebView2 starts.
        unsafe {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", webview2_browser_args());
        }
    }
}

/// Identity on Windows — browser args must not be set per-window (see module docs).
pub fn apply_window_builder<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}
