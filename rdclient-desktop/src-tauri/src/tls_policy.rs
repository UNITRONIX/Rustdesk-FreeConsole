//! TLS policy for operator panels (HTTP, self-signed, Let's Encrypt with incomplete chain).
//!
//! Linux: patched `wry` sets WebKit `TLSErrorsPolicy::Ignore` on each WebContext.
//! Windows: WebView2 `--ignore-certificate-errors` via builder + env fallback.
//!
//! Set `BETTERDESK_TLS_STRICT=1` to use system certificate validation (production CA only).

use tauri::{Runtime, WebviewWindowBuilder};

pub fn tls_strict() -> bool {
    std::env::var("BETTERDESK_TLS_STRICT")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

/// Call before `tauri::Builder::run` (Windows WebView2 environment).
pub fn init() {
    if tls_strict() {
        return;
    }

    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        // SAFETY: single-threaded before WebView2 starts.
        unsafe {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--ignore-certificate-errors",
            );
        }
    }
}

pub fn apply_window_builder<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    if tls_strict() {
        return builder;
    }

    #[cfg(windows)]
    {
        builder.additional_browser_args("--ignore-certificate-errors")
    }

    #[cfg(not(windows))]
    {
        builder
    }
}
