# CDAP — Connected Device Automation Protocol

CDAP is BetterDesk's protocol for managing IoT devices, servers, and custom hardware through the web console.

---

## Overview

CDAP enables:
- **Telemetry** — Real-time metrics (CPU, memory, disk, custom sensors)
- **Widget rendering** — 8 widget types displayed in the web console
- **Remote commands** — Execute actions on devices
- **Terminal access** — Full PTY terminal emulation
- **File management** — Browse, read, write, delete files
- **Clipboard sync** — Bidirectional clipboard
- **Screenshots** — On-demand screen capture
- **Audio streaming** — Bidirectional audio via WebSocket

---

## Architecture

```
Device / Bridge                    Go Server                  Web Console
      |                               |                           |
      |--- WebSocket connect -------->|(:21122/cdap)              |
      |<-- auth challenge ------------|                           |
      |--- auth response ------------>|                           |
      |<-- auth ok -------------------|                           |
      |--- manifest ----------------->|                           |
      |                               |                           |
      |--- widget_values ------------>|                           |
      |                               |--- HTTP /api/cdap ------->|
      |                               |<-- command ---------------|
      |<-- command -------------------|                           |
      |--- command_response --------->|                           |
```

---

## Enabling CDAP

### Go Server

```bash
# CLI flag
betterdesk-server -cdap

# Environment variable
CDAP_ENABLED=Y
```

### API Key

Create a CDAP API key:

```bash
curl -X POST http://your-server:21114/api/keys \
  -H "X-API-Key: your-admin-api-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "cdap-agent", "role": "operator"}'
```

---

## Protocol Messages

### Authentication

```json
// Server → Device
{"type": "auth_challenge", "nonce": "random-string"}

// Device → Server
{"type": "auth_response", "api_key": "your-cdap-key", "device_id": "DEVICE-001"}

// Server → Device
{"type": "auth_ok", "session_id": "uuid"}
```

### Manifest

Devices send their manifest after authentication:

```json
{
  "type": "manifest",
  "device": {
    "id": "CDAP-6A9A5452",
    "name": "Production Server",
    "type": "os_agent",
    "version": "1.0.0",
    "capabilities": ["telemetry", "commands", "remote_desktop", "file_transfer", "clipboard"]
  },
  "widgets": [
    {
      "id": "sys_cpu",
      "type": "gauge",
      "label": "CPU Usage",
      "group": "System",
      "unit": "%",
      "min": 0,
      "max": 100,
      "danger": 90,
      "warning": 70
    }
  ],
  "heartbeat_interval": 15
}
```

### Widget Types

| Type | Description | Config Fields |
|------|-------------|---------------|
| `gauge` | Percentage bar with thresholds | min, max, unit, danger, warning |
| `text` | Text display | (none) |
| `toggle` | On/off switch | (none) |
| `button` | Action trigger | confirm (boolean) |
| `led` | Status indicator | (none) |
| `slider` | Range input | min, max, step, unit |
| `select` | Dropdown choice | options (array) |
| `chart` | Bar chart (last N values) | max_points |

### Widget Values

```json
{
  "type": "widget_values",
  "values": {
    "sys_cpu": 45.2,
    "sys_memory": 72.8,
    "sys_disk": 38.5,
    "sys_hostname": "prod-server-01",
    "sys_uptime": "5d 12h 30m"
  }
}
```

### Commands

```json
// Server → Device
{
  "type": "command",
  "id": 42,
  "widget_id": "reboot_btn",
  "action": "press",
  "params": {}
}

// Device → Server
{
  "type": "command_response",
  "id": 42,
  "success": true,
  "message": "Reboot initiated"
}
```

### Terminal

```json
// Server → Device
{"type": "terminal_start", "cols": 80, "rows": 24}

// Device → Server
{"type": "terminal_output", "data": "user@host:~$ "}

// Server → Device
{"type": "terminal_input", "data": "ls -la\n"}

// Server → Device
{"type": "terminal_resize", "cols": 120, "rows": 40}

// Server → Device
{"type": "terminal_kill"}

// Device → Server
{"type": "terminal_end", "code": 0}
```

### File Browser

```json
// Server → Device
{"type": "file_list", "path": "/var/log"}

// Device → Server
{
  "type": "file_list_response",
  "path": "/var/log",
  "entries": [
    {"name": "syslog", "size": 1048576, "is_dir": false, "modified": "2026-03-27T12:00:00Z"},
    {"name": "nginx", "size": 0, "is_dir": true, "modified": "2026-03-27T11:00:00Z"}
  ]
}

// Server → Device
{"type": "file_read", "path": "/var/log/syslog", "offset": 0, "length": 65536}

// Device → Server
{"type": "file_read_response", "path": "/var/log/syslog", "data": "<base64>", "total_size": 1048576}

// Server → Device
{"type": "file_write", "path": "/tmp/config.json", "data": "<base64>"}

// Device → Server
{"type": "file_write_response", "success": true}

// Server → Device
{"type": "file_delete", "path": "/tmp/old-file.txt"}

// Device → Server
{"type": "file_delete_response", "success": true}
```

---

## SDKs

See the dedicated [[SDK]] page for Python and Node.js installation, bridge examples, and widget definitions. Quick start:

```bash
# Python
pip install betterdesk-cdap

# Node.js
npm install betterdesk-cdap
```

---

## Reference Bridges

Pre-built bridges for common protocols:

| Bridge | Protocol | Description |
|--------|----------|-------------|
| `bridges/modbus/` | Modbus TCP/RTU | Register polling, data type encode/decode, write-back |
| `bridges/snmp/` | SNMP v2c/v3 | OID polling, timetick formatting, counter rates |
| `bridges/rest-webhook/` | REST + Webhook | HTTP polling + aiohttp webhook listener |

### Modbus Bridge Example

```bash
cd bridges/modbus
pip install -r requirements.txt

python bridge.py \
  --server ws://your-server:21122/cdap \
  --api-key your-key \
  --modbus-host 192.168.1.100 \
  --modbus-port 502
```

---

## Web Console Integration

CDAP devices appear in the device list with a **CDAP** badge. Click a CDAP device to see:

1. **Device info** — Type, version, uptime, capabilities
2. **Widget grid** — Live widget rendering with interactive controls
3. **Command log** — History of commands sent to the device

### Widget Rendering

The web console renders widgets based on type:
- **Gauge** — Colored progress bar with danger/warning thresholds
- **Toggle** — iOS-style switch with on/off state
- **Button** — Click to send command (optional confirmation dialog)
- **LED** — Green/red/yellow indicator dot
- **Text** — Display any text/number value
- **Slider** — Range input with min/max labels
- **Select** — Dropdown menu with options
- **Chart** — Horizontal bar chart for last N values

### CDAP Routes (Web Console)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cdap/devices/{id}` | Device detail page |
| `GET` | `/api/cdap/status` | Gateway status |
| `GET` | `/api/cdap/devices` | Connected devices list |
| `GET` | `/api/cdap/devices/{id}/info` | Device info JSON |
| `GET` | `/api/cdap/devices/{id}/manifest` | Device manifest |
| `GET` | `/api/cdap/devices/{id}/state` | Widget state values |
| `POST` | `/api/cdap/devices/{id}/command` | Send command |

---

## Security

- CDAP gateway uses API key authentication
- WebSocket connections require valid auth response
- Terminal access requires `operator` role minimum
- File operations enforce path traversal protection (`safePath()`)
- Command sending requires `operator` role
- File deletion is audited

---

## See also

- [[SDK]] — Python and Node.js CDAP SDK
- [[Web Console|Web-Console]] — CDAP device pages in the panel
- [CDAP docs in repo](https://github.com/UNITRONIX/BetterDesk/tree/main/docs/cdap)
