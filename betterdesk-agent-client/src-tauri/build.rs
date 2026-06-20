use std::{env, path::PathBuf, process::Command};

fn main() {
    build_go_sidecar();
    tauri_build::build();
}

/// Compile the `betterdesk-agent` Go binary and place it in
/// `src-tauri/binaries/` using the Tauri externalBin naming convention:
/// `betterdesk-agent-<target-triple>[.exe]`.
///
/// Silently skips if Go is not installed or the agent source is missing —
/// the developer can still run using the system-installed binary via PATH
/// or `$BETTERDESK_AGENT_BIN`.
fn build_go_sidecar() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    // The agent lives two levels up: <repo>/betterdesk-agent/
    let agent_dir = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("betterdesk-agent"))
        .unwrap_or_default();

    if !agent_dir.exists() {
        println!(
            "cargo:warning=[sidecar] betterdesk-agent not found at {:?} — skipping Go build",
            agent_dir
        );
        return;
    }

    // Map Cargo target triple → Go GOOS/GOARCH
    let target_triple = env::var("TARGET").unwrap_or_default();
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    let (goos, goarch) = match (target_os.as_str(), target_arch.as_str()) {
        ("windows", "x86_64") => ("windows", "amd64"),
        ("windows", "aarch64") => ("windows", "arm64"),
        ("linux", "x86_64") => ("linux", "amd64"),
        ("linux", "aarch64") => ("linux", "arm64"),
        ("macos" | "darwin", "x86_64") => ("darwin", "amd64"),
        ("macos" | "darwin", "aarch64") => ("darwin", "arm64"),
        _ => ("linux", "amd64"),
    };

    let bin_name = if goos == "windows" {
        format!("betterdesk-agent-{}.exe", target_triple)
    } else {
        format!("betterdesk-agent-{}", target_triple)
    };

    let binaries_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir).ok();
    let output_path = binaries_dir.join(&bin_name);

    let status = Command::new("go")
        .current_dir(&agent_dir)
        .env("GOOS", goos)
        .env("GOARCH", goarch)
        .env("CGO_ENABLED", "0")
        .args(["build", "-ldflags", "-s -w", "-o", output_path.to_str().unwrap(), "."])
        .status();

    match status {
        Ok(s) if s.success() => {
            println!(
                "cargo:warning=[sidecar] Built Go agent → {}",
                output_path.display()
            );
        }
        Ok(s) => {
            println!(
                "cargo:warning=[sidecar] Go build failed (exit {}). The agent binary must be placed in PATH manually.",
                s
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=[sidecar] Go not found ({}). Install Go 1.21+ or set BETTERDESK_AGENT_BIN.",
                e
            );
        }
    }

    // Re-run whenever Go sources change
    println!(
        "cargo:rerun-if-changed={}",
        agent_dir.join("go.mod").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        agent_dir.join("main.go").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        agent_dir.join("agent").display()
    );
}
