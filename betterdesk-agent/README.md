# BetterDesk Agent

CDAP (Connected Device Automation Protocol) agent for BetterDesk. Connects to a BetterDesk server's CDAP gateway and provides system monitoring, remote terminal, file browser, clipboard sync, and screenshot capabilities.

## Features

- **System Monitoring** — CPU, memory, disk usage (gauges updated via heartbeat)
- **Remote Terminal** — Full PTY shell on Linux/macOS, pipe-based on Windows
- **File Browser** — Directory listing, file read/write/delete with path sanitization
- **Clipboard Sync** — Read/write system clipboard (xclip/xsel/wl-copy/PowerShell)
- **Screenshot Capture** — On-demand JPEG screenshot (ImageMagick/scrot/PowerShell)
- **Automatic Reconnect** — Exponential backoff with jitter
- **Cross-Platform** — Linux, macOS, Windows (single binary, no CGo)

## Quick Start

```bash
# Build
cd betterdesk-agent
go build -o betterdesk-agent .

# Run
./betterdesk-agent \
  -server ws://your-server:21122/cdap \
  -auth api_key \
  -key YOUR_API_KEY
```

## Configuration

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `-server` | Gateway WebSocket URL | `ws://localhost:21122/cdap` |
| `-auth` | Auth method: `api_key`, `device_token`, `user_password` | `api_key` |
| `-key` | API key | |
| `-token` | Device enrollment token | |
| `-user` | Username | |
| `-pass` | Password | |
| `-device-id` | Device ID | auto-assigned |
| `-device-name` | Device display name | hostname |
| `-device-type` | Device type | `os_agent` |
| `-config` | JSON config file path | |
| `-data-dir` | Data directory | `/var/lib/betterdesk-agent` |
| `-log-level` | Log level: debug, info, warning, error | `info` |
| `-version` | Print version | |

### Config File (JSON)

```json
{
  "server": "ws://203.0.113.10:21122/cdap",
  "auth_method": "api_key",
  "api_key": "your-api-key-here",
  "device_name": "Production Server",
  "device_type": "os_agent",
  "tags": ["production", "linux"],
  "terminal": true,
  "file_browser": true,
  "clipboard": true,
  "screenshot": true,
  "file_root": "/",
  "heartbeat_sec": 15,
  "log_level": "info"
}
```

### Environment Variables

All config fields can be overridden via `BDAGENT_*` environment variables:

```bash
BDAGENT_SERVER=ws://host:21122/cdap
BDAGENT_AUTH_METHOD=api_key
BDAGENT_API_KEY=your-key
BDAGENT_DEVICE_NAME=my-server
BDAGENT_TERMINAL=Y        # Y/N to enable/disable
BDAGENT_FILE_BROWSER=Y
BDAGENT_CLIPBOARD=Y
BDAGENT_SCREENSHOT=Y
BDAGENT_LOG_LEVEL=debug
```

Priority: CLI flags > Environment variables > Config file > Defaults

## Building

```bash
# Current platform
go build -o betterdesk-agent .

# Linux AMD64
GOOS=linux GOARCH=amd64 go build -o betterdesk-agent-linux-amd64 .

# Linux ARM64
GOOS=linux GOARCH=arm64 go build -o betterdesk-agent-linux-arm64 .

# Windows
GOOS=windows GOARCH=amd64 go build -o betterdesk-agent.exe .
```

## Installation

### Linux (systemd)

```bash
sudo ./install/install.sh -s ws://your-server:21122/cdap -k YOUR_API_KEY
```

### Windows (NSSM service)

```powershell
# Run as Administrator
.\install\install.ps1 -Server ws://your-server:21122/cdap -Key YOUR_API_KEY
```

### Uninstall

```bash
# Linux
sudo ./install/install.sh -u

# Windows
.\install\install.ps1 -Uninstall
```

## Protocol

The agent communicates via the CDAP WebSocket protocol (port 21122 by default).

### Connection Flow

1. **Connect** — WebSocket dial to gateway
2. **Authenticate** — Send `auth` message with credentials
3. **Register** — Send `register` message with device manifest
4. **Operate** — Heartbeat loop + message dispatch (commands, terminal, files, etc.)
5. **Reconnect** — Automatic on disconnect with exponential backoff

### Supported Message Types

| Direction | Type | Description |
|-----------|------|-------------|
| Agent → Server | `heartbeat` | Metrics + widget values |
| Agent → Server | `state_update` | Single widget value change |
| Agent → Server | `command_response` | Command execution result |
| Agent → Server | `terminal_output` | Shell output data |
| Agent → Server | `terminal_end` | Shell session ended |
| Agent → Server | `file_list_response` | Directory listing |
| Agent → Server | `file_read_response` | File chunk data |
| Agent → Server | `desktop_frame` | Screenshot JPEG data |
| Server → Agent | `command` | Execute widget command |
| Server → Agent | `terminal_start` | Start shell session |
| Server → Agent | `terminal_data` | Shell input from browser |
| Server → Agent | `terminal_resize` | Resize terminal |
| Server → Agent | `file_list` | List directory |
| Server → Agent | `file_read` | Read file chunk |
| Server → Agent | `file_write` | Write file chunk |
| Server → Agent | `file_delete` | Delete file |
| Server → Agent | `clipboard_set` | Set clipboard content |
| Server → Agent | `desktop_start` | Request screenshot |

## Prerequisites

### Screenshot Support

- **Linux**: Install `scrot` or `ImageMagick` (`sudo apt install scrot` or `sudo apt install imagemagick`)
- **macOS**: Built-in `screencapture` (no install needed)
- **Windows**: PowerShell with .NET Framework (built-in)

### Clipboard Support

- **Linux (X11)**: Install `xclip` or `xsel` (`sudo apt install xclip`)
- **Linux (Wayland)**: Install `wl-clipboard` (`sudo apt install wl-clipboard`)
- **macOS/Windows**: Built-in (no install needed)

## License

Same as BetterDesk project — see repository LICENSE.
