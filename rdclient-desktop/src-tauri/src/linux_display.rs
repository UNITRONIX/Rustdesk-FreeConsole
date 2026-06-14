//! Linux display session setup (X11 + Wayland).
//!
//! WebKitGTK on Wayland often crashes with Gdk error 71 unless env workarounds
//! are applied before GTK initializes (see tauri-apps/tauri#10702).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiBackend {
    Auto,
    Wayland,
    X11,
}

fn env_is_set(key: &str) -> bool {
    std::env::var_os(key).is_some()
}

fn set_env_if_unset(key: &str, value: &str) {
    if !env_is_set(key) {
        // SAFETY: called from main() before any threads or GTK init.
        unsafe {
            std::env::set_var(key, value);
        }
    }
}

fn env_truthy(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

fn parse_backend_override() -> UiBackend {
    match std::env::var("BETTERDESK_UI_BACKEND")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("wayland") | Some("wl") => UiBackend::Wayland,
        Some("x11") | Some("x") => UiBackend::X11,
        _ => UiBackend::Auto,
    }
}

pub fn is_wayland_session() -> bool {
    if env_is_set("WAYLAND_DISPLAY") {
        return true;
    }
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
}

pub fn is_x11_session() -> bool {
    env_is_set("DISPLAY") && !is_wayland_session()
}

fn is_nvidia_driver_active() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::env::var("LIBVA_DRIVER_NAME")
            .map(|v| v.to_ascii_lowercase().contains("nvidia"))
            .unwrap_or(false)
}

fn apply_gdk_backend(backend: UiBackend) {
    if env_is_set("GDK_BACKEND") {
        return;
    }

    match backend {
        UiBackend::X11 => set_env_if_unset("GDK_BACKEND", "x11"),
        UiBackend::Wayland => set_env_if_unset("GDK_BACKEND", "wayland"),
        UiBackend::Auto => {
            if is_wayland_session() {
                // Prefer native Wayland; fall back to XWayland when compositor rejects the surface.
                set_env_if_unset("GDK_BACKEND", "wayland,x11");
            } else if is_x11_session() {
                set_env_if_unset("GDK_BACKEND", "x11");
            }
        }
    }
}

fn apply_webkit_workarounds(backend: UiBackend, wayland: bool) {
    if env_truthy("BETTERDESK_WEBKIT_NO_WORKAROUND") {
        return;
    }

    if is_nvidia_driver_active() {
        // Keeps GPU acceleration on many NVIDIA + Wayland setups without disabling DMA-BUF.
        set_env_if_unset("__NV_DISABLE_EXPLICIT_SYNC", "1");
        set_env_if_unset("__GL_THREADED_OPTIMIZATIONS", "0");
    }

    let force_dmabuf_off = env_truthy("BETTERDESK_WEBKIT_DISABLE_DMABUF")
        || env_truthy("BETTERDESK_WEBKIT_SAFE");

    let default_dmabuf_off = wayland && matches!(backend, UiBackend::Auto | UiBackend::Wayland);

    if force_dmabuf_off || default_dmabuf_off {
        set_env_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    if env_truthy("BETTERDESK_WEBKIT_NO_COMPOSITING") {
        set_env_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

/// Must run before Tauri/GTK initialization.
pub fn init() {
    let backend = parse_backend_override();
    let wayland = matches!(backend, UiBackend::Wayland)
        || (matches!(backend, UiBackend::Auto) && is_wayland_session());

    apply_gdk_backend(backend);
    apply_webkit_workarounds(backend, wayland);
}
