# BetterDesk - Building from Source

This guide explains how to build BetterDesk enhanced binaries from source code.

## Overview

BetterDesk is built on top of the official RustDesk Server with additional modifications:
- HTTP API for device management
- Real-time online status tracking
- Device banning capabilities
- Enhanced database schema

## Quick Start

### Linux
```bash
# Interactive build
./build-betterdesk.sh

# Automatic build with defaults
./build-betterdesk.sh --auto
```

### Windows
```powershell
# Interactive build
.\build-betterdesk.ps1

# Automatic build with defaults
.\build-betterdesk.ps1 -Auto
```

---

## Manual Build Process

### Prerequisites

#### Linux
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y build-essential libsqlite3-dev pkg-config libssl-dev git

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

#### Windows
1. Install [Rust](https://rustup.rs/)
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with C++ support
3. Install [Git](https://git-scm.com/)

### Step 1: Clone RustDesk Server

```bash
# Clone specific version
git clone --depth 1 --branch 1.1.14 https://github.com/rustdesk/rustdesk-server.git
cd rustdesk-server

# Initialize submodules
git submodule update --init --recursive
```

### Step 2: Apply BetterDesk Modifications

Copy the modification files from `hbbs-patch-v2/src/` to the RustDesk source:

```bash
# From the Rustdesk-FreeConsole directory
cp hbbs-patch-v2/src/main.rs rustdesk-server/src/
cp hbbs-patch-v2/src/http_api.rs rustdesk-server/src/
cp hbbs-patch-v2/src/database.rs rustdesk-server/src/
cp hbbs-patch-v2/src/peer.rs rustdesk-server/src/
```

### Step 3: Build Binaries

```bash
cd rustdesk-server

# Build Signal Server (hbbs)
cargo build --release -p hbbs

# Build Relay Server (hbbr)
cargo build --release -p hbbr
```

### Step 4: Locate Binaries

After successful build, binaries are located in:
- `target/release/hbbs` (Linux) or `target/release/hbbs.exe` (Windows)
- `target/release/hbbr` (Linux) or `target/release/hbbr.exe` (Windows)

---

## Cross-Compilation

### Linux ARM64 (from x86_64)

```bash
# Install cross-compiler
sudo apt-get install -y gcc-aarch64-linux-gnu

# Add Rust target
rustup target add aarch64-unknown-linux-gnu

# Configure linker
cat >> .cargo/config.toml << EOF
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
EOF

# Build
cargo build --release --target aarch64-unknown-linux-gnu -p hbbs
cargo build --release --target aarch64-unknown-linux-gnu -p hbbr
```

### Windows from Linux (using cross)

```bash
# Install cross
cargo install cross

# Build Windows binaries
cross build --release --target x86_64-pc-windows-gnu -p hbbs
cross build --release --target x86_64-pc-windows-gnu -p hbbr
```

---

## Modification Files

| File | Purpose |
|------|---------|
| `main.rs` | Entry point with `--api-port` argument, HTTP API startup |
| `http_api.rs` | Full HTTP API implementation (list, online status, ban) |
| `database.rs` | Database operations with BetterDesk extensions |
| `peer.rs` | Peer management with additional fields |

### Key Modifications in main.rs

```rust
// Added command-line argument
#[arg(long, value_name = "PORT", help = "HTTP API port for BetterDesk Console")]
api_port: Option<u16>,

// API startup in main()
if let Some(port) = opt.api_port {
    let db_path = db_dir.clone();
    tokio::spawn(async move {
        http_api::start_api_server(port, db_path).await;
    });
}
```

### Key Features in http_api.rs

```rust
// Endpoints
GET  /api/peers          - List all registered devices
GET  /api/peers/online   - List currently online devices
POST /api/peers/{id}/ban - Ban a device
```

---

## GitHub Actions CI/CD

The project includes automated builds via GitHub Actions.

### Automatic Triggers
- Go server builds on every push to `main` or `dev`, and on version tags (`v*`)
- Other project workflows may have additional path-specific triggers

### Manual Trigger
1. Go to Actions tab in GitHub
2. Select "Build BetterDesk Binaries"
3. Click "Run workflow"
4. Optionally select RustDesk version and release options

### Artifacts
The `Build & Release Go Server` workflow publishes one artifact per supported
server target. Each artifact includes the binary and a JSON manifest containing
the exact commit SHA, Go target, byte size and SHA-256. The panel uses an
artifact only when its workflow run and manifest match the requested update
commit; failed, in-progress or expired artifacts fall back to a local build.

Tag runs also attach the binaries, per-binary manifests and
`SERVER_CHECKSUMS.sha256` to the GitHub Release. For private repositories,
native panel updates need `UPDATE_GITHUB_TOKEN` with read access to Actions
artifacts and repository contents. Do not use a generic `latest` release asset
as a substitute for an exact commit.

---

## Build Script Options

### Linux (build-betterdesk.sh)

| Option | Description |
|--------|-------------|
| `--auto` | Non-interactive mode with defaults |
| `--clean` | Clean build directory |
| `--version VERSION` | Specify RustDesk version |
| `--platform PLATFORM` | Target: linux-x64, linux-arm64, windows-x64 |
| `--help` | Show help |

### Windows (build-betterdesk.ps1)

| Option | Description |
|--------|-------------|
| `-Auto` | Non-interactive mode |
| `-Clean` | Clean build directory |
| `-Version VERSION` | Specify RustDesk version |
| `-Platform PLATFORM` | Target platform |
| `-Help` | Show help |

---

## Troubleshooting

### Build Fails with SQLite Errors

```bash
# Linux - Install SQLite dev package
sudo apt-get install libsqlite3-dev

# Or use bundled SQLite
cargo build --release --features bundled
```

### Missing OpenSSL

```bash
# Linux
sudo apt-get install libssl-dev pkg-config

# Windows: Usually bundled, but if needed:
# Install via vcpkg or use openssl-sys
```

### Axum Version Mismatch

BetterDesk uses axum 0.5.x. If upgrading RustDesk base version, check Cargo.toml for axum version changes.

### Cross-Compilation Fails

```bash
# Ensure correct linker is configured
# For ARM64:
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
```

---

## Verifying Builds

### Check Binary Version

```bash
./hbbs-linux-x86_64 --version
```

### Verify API Port Support

```bash
./hbbs-linux-x86_64 --help | grep api-port
```

Should show:
```
--api-port <PORT>    HTTP API port for BetterDesk Console
```

### Test API Functionality

```bash
# Start server with API
./hbbs-linux-x86_64 -k _ --api-port 21114 &

# Test API
curl http://localhost:21114/api/peers
```

---

## Contributing Modifications

1. Make changes in `hbbs-patch-v2/src/`
2. Test locally with build scripts
3. Submit PR with updated source files
4. CI will automatically build and test

See [CONTRIBUTING.md](../development/CONTRIBUTING.md) for full guidelines.

---

## Version Tracking

| Component | Version |
|-----------|---------|
| RustDesk Server Base | 1.1.14 |
| BetterDesk HTTP API | 2.0.0 |
| Install Scripts | 1.5.x |

When updating RustDesk base version:
1. Test API compatibility
2. Update build scripts
3. Rebuild all platform binaries
4. Update CHECKSUMS.md
