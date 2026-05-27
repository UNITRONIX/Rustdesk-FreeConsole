//! Session border overlay — native click-through window pinned to the primary
//! monitor while a remote session is active.
//!
//! This is intentionally separate from the in-app `SessionOverlay` Solid
//! component: the in-app component still owns the collapsible disconnect
//! widget, but the *coloured border* is now drawn by a dedicated borderless,
//! transparent, always-on-top, cursor-transparent webview window that covers
//! the entire primary monitor — so the user sees the warning frame around
//! their screen, not just around the agent window.

use log::{info, warn};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder,
};

const OVERLAY_LABEL: &str = "session-border";

/// Show (or reuse) the full-screen border overlay window on the primary
/// monitor. `mode` is either `"supervised"` or `"unattended"` and controls
/// the colour (amber vs red).
pub fn show(app: &AppHandle, mode: &str) {
    let mode = if mode == "unattended" {
        "unattended"
    } else {
        "supervised"
    };

    // Already showing → just navigate to refresh the colour and bail.
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let url = format!("session-border.html?mode={}", mode);
        if let Err(e) = existing.eval(&format!(
            "window.location.replace({:?});",
            url
        )) {
            warn!("[session-overlay] reload failed: {}", e);
        }
        let _ = existing.show();
        let _ = existing.set_always_on_top(true);
        let _ = existing.set_ignore_cursor_events(true);
        return;
    }

    // Resolve primary monitor geometry. Tauri returns *physical* pixels; we
    // convert to logical so multi-DPI displays still get a full-screen
    // overlay regardless of scale factor.
    let (logical_pos, logical_size) = match app.primary_monitor() {
        Ok(Some(m)) => {
            let scale = m.scale_factor();
            let pp: PhysicalPosition<i32> = *m.position();
            let ps: PhysicalSize<u32> = *m.size();
            (
                LogicalPosition::new(pp.x as f64 / scale, pp.y as f64 / scale),
                LogicalSize::new(ps.width as f64 / scale, ps.height as f64 / scale),
            )
        }
        Ok(None) => {
            warn!("[session-overlay] No primary monitor reported — falling back to 1920x1080");
            (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1920.0, 1080.0))
        }
        Err(e) => {
            warn!("[session-overlay] primary_monitor() failed: {} — skipping", e);
            return;
        }
    };

    let url = format!("session-border.html?mode={}", mode);
    // NOTE: on Linux/GTK (tao 0.34) several `WebviewWindowBuilder` flags can
    // panic in the event loop *after* the window is shown (closable/maximizable
    // /minimizable(false), focused(false), shadow(false) combined with
    // transparent+decorations(false) trigger `Option::unwrap` on a None value
    // inside `event_loop.rs:448`). We therefore keep the builder minimal and
    // apply the cursor-pass-through *after* `show()` once the GTK widget is
    // realised.
    let builder = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App(url.into()))
        .title("BetterDesk Session")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false) // show after positioning to avoid flicker
        .inner_size(logical_size.width, logical_size.height)
        .position(logical_pos.x, logical_pos.y);

    match builder.build() {
        Ok(win) => {
            let _ = win.set_always_on_top(true);
            if let Err(e) = win.show() {
                warn!("[session-overlay] show() failed: {}", e);
            }
            // Click-through: pointer events fall through to whatever is beneath
            // the overlay. On Linux/GTK (tao 0.34) `set_ignore_cursor_events`
            // calls `gdk_window().unwrap()` which panics if the GTK widget has
            // not yet been *realised* — `show()` only queues realisation, it
            // does not guarantee a backing GdkWindow exists. We therefore defer
            // the call to a background thread which hops back onto the main
            // thread after a short delay so realisation has actually happened.
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let app_for_main = app_clone.clone();
                let _ = app_clone.run_on_main_thread(move || {
                    if let Some(w) = app_for_main.get_webview_window(OVERLAY_LABEL) {
                        if let Err(e) = w.set_ignore_cursor_events(true) {
                            warn!("[session-overlay] set_ignore_cursor_events failed: {}", e);
                        }
                    }
                });
            });
            info!(
                "[session-overlay] Border shown ({}x{} @ {},{} mode={})",
                logical_size.width, logical_size.height, logical_pos.x, logical_pos.y, mode
            );
        }
        Err(e) => warn!("[session-overlay] Failed to build overlay window: {}", e),
    }
}

/// Hide and destroy the overlay window (no-op if it does not exist).
pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        if let Err(e) = win.close() {
            warn!("[session-overlay] close failed: {}", e);
        } else {
            info!("[session-overlay] Border hidden");
        }
    }
}
