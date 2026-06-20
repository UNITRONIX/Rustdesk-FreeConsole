use serde::Serialize;
use sysinfo::System;

/// System information snapshot for registration and diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct SystemSnapshot {
    pub hostname: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub total_memory_mb: u64,
    pub total_disk_mb: u64,
    pub username: String,
}

impl SystemSnapshot {
    /// Collect current system information.
    pub fn collect() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let total_disk_mb: u64 = sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .map(|d| d.total_space() / 1_048_576)
            .sum();

        Self {
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            os: System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
            os_version: System::os_version().unwrap_or_else(|| "unknown".to_string()),
            arch: std::env::consts::ARCH.to_string(),
            cpu_name,
            cpu_cores: sys.cpus().len(),
            total_memory_mb: sys.total_memory() / 1_048_576,
            total_disk_mb,
            username: whoami::username(),
        }
    }
}

// ─────────────────────────── Rich Inventory ───────────────────────────

/// An installed application entry.
#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub install_date: String,
}

/// A system service entry.
#[derive(Debug, Clone, Serialize)]
pub struct SystemService {
    pub name: String,
    pub display_name: String,
    pub status: String,  // "running" | "stopped" | "unknown"
    pub start_type: String, // "auto" | "manual" | "disabled" | "unknown"
}

/// A disk partition entry.
#[derive(Debug, Clone, Serialize)]
pub struct DiskPartition {
    pub mount: String,
    pub filesystem: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub available_gb: f64,
    pub use_percent: f64,
}

/// A network interface entry.
#[derive(Debug, Clone, Serialize)]
pub struct NetworkAdapter {
    pub name: String,
    pub mac_address: String,
    pub ip_addresses: Vec<String>,
    pub bytes_received: u64,
    pub bytes_sent: u64,
}

/// Collect installed applications.
///
/// - **Windows**: reads `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
///   via `reg query` (no extra crates required).
/// - **Linux**: reads `/var/lib/dpkg/status` (Debian/Ubuntu) or runs `rpm -qa`
///   (RHEL/Fedora). Falls back to an empty list on unsupported systems.
/// - **macOS**: lists `/Applications/*.app` bundles via `ls`.
pub fn collect_installed_software() -> Vec<InstalledApp> {
    #[cfg(target_os = "windows")]
    return collect_installed_windows();

    #[cfg(target_os = "linux")]
    return collect_installed_linux();

    #[cfg(target_os = "macos")]
    return collect_installed_macos();

    // Unsupported platform
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    return vec![];
}

/// Collect running system services.
///
/// - **Windows**: `sc query type= service state= running` (no admin required).
/// - **Linux**: `systemctl list-units --type=service --state=running --plain --no-legend`.
/// - **macOS**: `launchctl list` — returns only running services.
pub fn collect_services() -> Vec<SystemService> {
    #[cfg(target_os = "windows")]
    return collect_services_windows();

    #[cfg(target_os = "linux")]
    return collect_services_linux();

    #[cfg(target_os = "macos")]
    return collect_services_macos();

    // Unsupported platform
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    return vec![];
}

/// Collect disk partitions from sysinfo.
pub fn collect_disk_partitions() -> Vec<DiskPartition> {
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let available = d.available_space();
            let used = total.saturating_sub(available);
            let use_pct = if total > 0 {
                (used as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            DiskPartition {
                mount: d.mount_point().to_string_lossy().to_string(),
                filesystem: d.file_system().to_string_lossy().to_string(),
                total_gb: total as f64 / 1_073_741_824.0,
                used_gb: used as f64 / 1_073_741_824.0,
                available_gb: available as f64 / 1_073_741_824.0,
                use_percent: (use_pct * 10.0).round() / 10.0,
            }
        })
        .collect()
}

/// Collect network adapters from sysinfo.
pub fn collect_network_adapters() -> Vec<NetworkAdapter> {
    use sysinfo::Networks;
    let networks = Networks::new_with_refreshed_list();
    networks
        .iter()
        .map(|(name, data)| {
            let ips: Vec<String> = data
                .ip_networks()
                .iter()
                .map(|n| n.addr.to_string())
                .collect();
            NetworkAdapter {
                name: name.clone(),
                mac_address: data.mac_address().to_string(),
                ip_addresses: ips,
                bytes_received: data.total_received(),
                bytes_sent: data.total_transmitted(),
            }
        })
        .collect()
}

// ─── Platform implementations ─────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn collect_installed_windows() -> Vec<InstalledApp> {
    use std::process::Command;

    let reg_paths = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    let mut apps: std::collections::HashMap<String, InstalledApp> =
        std::collections::HashMap::new();

    for path in &reg_paths {
        // List subkeys.
        let Ok(output) = Command::new("reg")
            .args(["query", path])
            .output()
        else {
            continue;
        };

        let listing = String::from_utf8_lossy(&output.stdout);
        for subkey in listing.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let Ok(values) = Command::new("reg")
                .args(["query", subkey, "/v", "DisplayName"])
                .output()
            else {
                continue;
            };

            let name_raw = String::from_utf8_lossy(&values.stdout);
            let name = reg_extract_value(&name_raw, "DisplayName");
            if name.is_empty() || name.starts_with("KB") {
                continue; // skip Windows Update entries
            }

            let version = reg_query_value(subkey, "DisplayVersion");
            let publisher = reg_query_value(subkey, "Publisher");
            let install_date = reg_query_value(subkey, "InstallDate");

            apps.entry(name.clone()).or_insert(InstalledApp {
                name,
                version,
                publisher,
                install_date,
            });
        }
    }

    let mut list: Vec<InstalledApp> = apps.into_values().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

#[cfg(target_os = "windows")]
fn reg_query_value(subkey: &str, value_name: &str) -> String {
    use std::process::Command;
    let Ok(output) = Command::new("reg")
        .args(["query", subkey, "/v", value_name])
        .output()
    else {
        return String::new();
    };
    let raw = String::from_utf8_lossy(&output.stdout);
    reg_extract_value(&raw, value_name)
}

#[cfg(target_os = "windows")]
fn reg_extract_value(raw: &str, value_name: &str) -> String {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.to_lowercase().starts_with(&value_name.to_lowercase()) {
            // Format: "    ValueName    REG_SZ    Actual value"
            let parts: Vec<&str> = trimmed.splitn(3, "    ").collect();
            if parts.len() >= 3 {
                return parts[2].trim().to_string();
            }
            // Alternative split with tabs
            let tab_parts: Vec<&str> = trimmed.splitn(3, '\t').collect();
            if tab_parts.len() >= 3 {
                return tab_parts[2].trim().to_string();
            }
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
fn collect_services_windows() -> Vec<SystemService> {
    use std::process::Command;

    // sc query returns all running services. We follow up with sc qc for start type
    // only if the list is small enough to avoid timeout.
    let Ok(output) = Command::new("sc").args(["query", "type=", "service", "state=", "all"]).output()
    else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services = Vec::new();
    let mut current_name = String::new();
    let mut current_display = String::new();
    let mut current_state = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("SERVICE_NAME:") {
            if !current_name.is_empty() {
                services.push(SystemService {
                    name: current_name.clone(),
                    display_name: current_display.clone(),
                    status: current_state.clone(),
                    start_type: "unknown".to_string(),
                });
            }
            current_name = name.trim().to_string();
            current_display = String::new();
            current_state = String::new();
        } else if let Some(disp) = trimmed.strip_prefix("DISPLAY_NAME:") {
            current_display = disp.trim().to_string();
        } else if trimmed.contains("RUNNING") {
            current_state = "running".to_string();
        } else if trimmed.contains("STOPPED") {
            current_state = "stopped".to_string();
        }
    }
    if !current_name.is_empty() {
        services.push(SystemService {
            name: current_name,
            display_name: current_display,
            status: current_state,
            start_type: "unknown".to_string(),
        });
    }

    services.sort_by(|a, b| a.name.cmp(&b.name));
    services
}

#[cfg(target_os = "linux")]
fn collect_installed_linux() -> Vec<InstalledApp> {
    // Try dpkg first (Debian/Ubuntu).
    if let Ok(content) = std::fs::read_to_string("/var/lib/dpkg/status") {
        return parse_dpkg_status(&content);
    }

    // Fallback: rpm -qa (RHEL/Fedora/SUSE).
    if let Ok(output) = std::process::Command::new("rpm")
        .args(["-qa", "--queryformat", "%{NAME}|%{VERSION}|%{VENDOR}|%{INSTALLTIME:date}\n"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        return text
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| {
                let parts: Vec<&str> = l.splitn(4, '|').collect();
                InstalledApp {
                    name: parts.first().copied().unwrap_or("").to_string(),
                    version: parts.get(1).copied().unwrap_or("").to_string(),
                    publisher: parts.get(2).copied().unwrap_or("").to_string(),
                    install_date: parts.get(3).copied().unwrap_or("").to_string(),
                }
            })
            .collect();
    }

    vec![]
}

#[cfg(target_os = "linux")]
fn parse_dpkg_status(content: &str) -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    let mut name = String::new();
    let mut version = String::new();
    let mut status = String::new();

    for line in content.lines() {
        if line.starts_with("Package: ") {
            name = line["Package: ".len()..].trim().to_string();
        } else if line.starts_with("Version: ") {
            version = line["Version: ".len()..].trim().to_string();
        } else if line.starts_with("Status: ") {
            status = line["Status: ".len()..].trim().to_string();
        } else if line.is_empty() {
            if !name.is_empty() && status.contains("installed") {
                apps.push(InstalledApp {
                    name: name.clone(),
                    version: version.clone(),
                    publisher: String::new(),
                    install_date: String::new(),
                });
            }
            name.clear();
            version.clear();
            status.clear();
        }
    }

    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps
}

#[cfg(target_os = "linux")]
fn collect_services_linux() -> Vec<SystemService> {
    use std::process::Command;

    // systemctl list-units --type=service --all --plain --no-legend
    let Ok(output) = Command::new("systemctl")
        .args(["list-units", "--type=service", "--all", "--plain", "--no-legend"])
        .output()
    else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services: Vec<SystemService> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 4 {
                return None;
            }
            let unit = parts[0].trim_end_matches(".service");
            let active = parts[2]; // "active" or "inactive"
            let sub = parts[3];    // "running", "exited", etc.
            Some(SystemService {
                name: unit.to_string(),
                display_name: parts.get(4..).map(|r| r.join(" ")).unwrap_or_default(),
                status: if active == "active" && sub == "running" {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                },
                start_type: "unknown".to_string(),
            })
        })
        .collect();

    // Enrich with start-type for reasonable-sized lists.
    if services.len() <= 200 {
        for svc in services.iter_mut() {
            if let Ok(out) = Command::new("systemctl")
                .args(["show", &svc.name, "--property=UnitFileState"])
                .output()
            {
                let raw = String::from_utf8_lossy(&out.stdout);
                svc.start_type = raw
                    .lines()
                    .find_map(|l| l.strip_prefix("UnitFileState="))
                    .unwrap_or("unknown")
                    .to_string();
            }
        }
    }

    services.sort_by(|a, b| a.name.cmp(&b.name));
    services
}

#[cfg(target_os = "macos")]
fn collect_installed_macos() -> Vec<InstalledApp> {
    use std::process::Command;

    let Ok(output) = Command::new("ls").arg("/Applications").output() else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut apps: Vec<InstalledApp> = text
        .lines()
        .filter(|l| l.ends_with(".app"))
        .map(|l| {
            let name = l.trim_end_matches(".app").to_string();
            InstalledApp {
                name,
                version: String::new(),
                publisher: String::new(),
                install_date: String::new(),
            }
        })
        .collect();

    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps
}

#[cfg(target_os = "macos")]
fn collect_services_macos() -> Vec<SystemService> {
    use std::process::Command;

    let Ok(output) = Command::new("launchctl").arg("list").output() else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services: Vec<SystemService> = text
        .lines()
        .skip(1) // header row
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() < 3 {
                return None;
            }
            let pid = parts[0].trim();
            let name = parts[2].trim().to_string();
            Some(SystemService {
                display_name: name.clone(),
                name,
                status: if pid != "-" { "running".to_string() } else { "stopped".to_string() },
                start_type: "unknown".to_string(),
            })
        })
        .collect();

    services.sort_by(|a, b| a.name.cmp(&b.name));
    services
}
