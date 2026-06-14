//! TLS policy for operator panels (HTTP, self-signed, Let's Encrypt with incomplete chain).
//!
//! Linux: patched `wry` sets WebKit `TLSErrorsPolicy::Ignore` on each WebContext.
//! Windows: WebView2 `--ignore-certificate-errors` via builder + env fallback.
//!
//! Set `BETTERDESK_TLS_STRICT=1` to use system certificate validation (production CA only).

use tauri::{Runtime, WebviewWindowBuilder};

const WEBVIEW2_MEDIA_ARGS: &str = "\
--enable-gpu-rasterization \
--enable-accelerated-video-decode \
--enable-features=PlatformAV1VideoDecoder,PlatformHEVCDecoderSupport,VaapiVideoDecoder,WebCodecs \
--disable-features=UseSurfaceLayerForVideo";

pub fn tls_strict() -> bool {
    std::env::var("BETTERDESK_TLS_STRICT")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

fn webview2_browser_args() -> String {
    let mut parts = Vec::new();
    if !tls_strict() {
        parts.push("--ignore-certificate-errors");
    }
    parts.push(WEBVIEW2_MEDIA_ARGS);
    parts.join(" ")
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

pub fn apply_window_builder<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(windows)]
    {
        builder.additional_browser_args(webview2_browser_args())
    }

    #[cfg(not(windows))]
    {
        builder
    }
}
