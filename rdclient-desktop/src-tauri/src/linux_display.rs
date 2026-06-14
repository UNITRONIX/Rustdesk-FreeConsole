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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Unknown,
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

fn read_pci_vendor(path: &std::path::Path) -> Option<u32> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    u32::from_str_radix(hex, 16).ok()
}

fn drm_primary_pci_vendor() -> Option<u32> {
    let drm = std::fs::read_dir("/sys/class/drm").ok()?;
    let mut best: Option<(u32, u32)> = None;

    for entry in drm.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") {
            continue;
        }
        let suffix = &name[4..];
        if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let card_num: u32 = suffix.parse().ok()?;
        let vendor_path = entry.path().join("device/vendor");
        let Some(vendor) = read_pci_vendor(&vendor_path) else {
            continue;
        };
        if best.map(|(n, _)| card_num < n).unwrap_or(true) {
            best = Some((card_num, vendor));
        }
    }

    best.map(|(_, vendor)| vendor)
}

fn gpu_vendor() -> GpuVendor {
    if is_nvidia_driver_active() {
        return GpuVendor::Nvidia;
    }

    match drm_primary_pci_vendor() {
        Some(0x8086) => GpuVendor::Intel,
        Some(0x1002) | Some(0x1022) => GpuVendor::Amd,
        Some(0x10de) => GpuVendor::Nvidia,
        _ => GpuVendor::Unknown,
    }
}

fn nvidia_vaapi_driver_present() -> bool {
    for path in [
        "/usr/lib64/dri/nvidia_drv_video.so",
        "/usr/lib/dri/nvidia_drv_video.so",
        "/usr/lib/x86_64-linux-gnu/dri/nvidia_drv_video.so",
    ] {
        if std::path::Path::new(path).exists() {
            return true;
        }
    }
    false
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
                set_env_if_unset("GDK_BACKEND", "wayland,x11");
            } else if is_x11_session() {
                set_env_if_unset("GDK_BACKEND", "x11");
            }
        }
    }
}

fn apply_webkit_workarounds(backend: UiBackend, vendor: GpuVendor) {
    if env_truthy("BETTERDESK_WEBKIT_NO_WORKAROUND") {
        return;
    }

    if vendor == GpuVendor::Nvidia {
        set_env_if_unset("__NV_DISABLE_EXPLICIT_SYNC", "1");
        set_env_if_unset("__GL_THREADED_OPTIMIZATIONS", "0");
    }

    let force_dmabuf_off = env_truthy("BETTERDESK_WEBKIT_DISABLE_DMABUF")
        || env_truthy("BETTERDESK_WEBKIT_SAFE");

    let nvidia_x11_dmabuf_off =
        vendor == GpuVendor::Nvidia
            && is_x11_session()
            && matches!(backend, UiBackend::Auto | UiBackend::X11);

    if force_dmabuf_off || nvidia_x11_dmabuf_off {
        set_env_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    if env_truthy("BETTERDESK_WEBKIT_NO_COMPOSITING") {
        set_env_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

/// GStreamer / VA-API hints for WebKitGTK WebCodecs (Intel, AMD, NVIDIA).
fn apply_webkit_media_acceleration(vendor: GpuVendor) {
    if env_truthy("BETTERDESK_WEBKIT_NO_MEDIA_ACCEL") {
        return;
    }

    set_env_if_unset("GST_VAAPI_ALL_DRIVERS", "1");
    set_env_if_unset("GST_GL_XINITTHREADS", "1");

    // Prefer VA-API hardware decoders over software (dav1d, libvpx, etc.).
    set_env_if_unset(
        "GST_PLUGIN_FEATURE_RANK",
        "vaav1dec:MAX,vah264dec:MAX,vavp9dec:MAX,vah265dec:MAX,vaapidecodebin:MAX,nvh264dec:MAX,nvh265dec:MAX,nvav1dec:MAX",
    );

    match vendor {
        GpuVendor::Intel => {
            set_env_if_unset("LIBVA_DRIVER_NAME", "iHD");
        }
        GpuVendor::Amd => {
            set_env_if_unset("LIBVA_DRIVER_NAME", "radeonsi");
            set_env_if_unset("RADV_PERFTEST", "video_decode");
        }
        GpuVendor::Nvidia if nvidia_vaapi_driver_present() => {
            set_env_if_unset("LIBVA_DRIVER_NAME", "nvidia");
            set_env_if_unset("NVD_BACKEND", "direct");
        }
        GpuVendor::Nvidia => {
            // Without nvidia-vaapi, GStreamer may still use nvh264dec/nvdec via plugin rank.
        }
        GpuVendor::Unknown => {}
    }
}

/// Must run before Tauri/GTK initialization.
pub fn init() {
    let backend = parse_backend_override();
    let vendor = gpu_vendor();

    apply_gdk_backend(backend);
    apply_webkit_workarounds(backend, vendor);
    apply_webkit_media_acceleration(vendor);
}
