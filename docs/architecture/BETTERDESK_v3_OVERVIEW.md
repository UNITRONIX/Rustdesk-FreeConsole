# BetterDesk v3.0 — Ultimate Remote & CDAP Solution

> **Version**: 3.0.0  
> **Codename**: Ultimate  
> **Release Date**: March 2026

---

## What's New in v3.0

BetterDesk v3.0 is a major release that transforms BetterDesk from a RustDesk-compatible server into a **complete device management ecosystem**. The key additions are:

1. **CDAP (Custom Device API Protocol)** — A WebSocket-based protocol for connecting IoT devices, SCADA controllers, network equipment, and custom agents to the BetterDesk panel alongside RustDesk clients.

2. **BetterDesk Minimal Mode** — Server-only installation without the web console, for headless deployments or API-only usage.

3. **Media Channel** — Binary frame relay for remote desktop sessions between CDAP devices with E2E encryption.

4. **Bridge Ecosystem** — Python SDK and reference bridges (Modbus TCP, SNMP, REST webhook) for connecting industrial and network devices.

5. **Desktop Mode (Beta)** — Experimental desktop-like interface for the web console with floating windows, widgets, and taskbar.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BetterDesk v3.0 Ecosystem                     │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                  BetterDesk Go Server                      │   │
│  │                  (single binary)                           │   │
│  │                                                            │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ Signal   │  │ Relay    │  │ HTTP API │  │ CDAP     │ │   │
│  │  │ :21116   │  │ :21117   │  │ :21121   │  │ Gateway  │ │   │
│  │  │ UDP/TCP  │  │ TCP/WS   │  │ REST+    │  │ :21122   │ │   │
│  │  │          │  │          │  │ ClientAPI│  │          │ │   │
│  │  │ +WS:18   │  │ +WS:19   │  │          │  │ WS+TLS   │ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  │                                                            │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ Auth     │  │ Database │  │ Audit    │  │ Metrics  │ │   │
│  │  │ JWT+TOTP │  │ SQLite/  │  │ Ring Log │  │ Prometheus│ │   │
│  │  │ +RBAC    │  │ Postgres │  │          │  │          │ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              BetterDesk Web Console (Node.js)              │   │
│  │              Port 5000 (LAN) — proxies to Go :21121       │   │
│  │                                                            │   │
│  │  Dashboard │ Devices │ Users │ Automation │ CDAP │ Remote │   │
│  │  Tickets   │ Reports │ Inventory │ Desktop Mode (Beta)    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ RustDesk     │  │ CDAP Native  │  │ CDAP Bridges         │   │
│  │ Clients      │  │ Agent        │  │ (Modbus, SNMP, REST) │   │
│  │ (Desktop/    │  │ (Desktop +   │  │                      │   │
│  │  Mobile)     │  │  Management) │  │                      │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Installation Modes

### Full Installation (default)
Installs Go server + Node.js web console + all features.

```bash
# Linux
sudo ./betterdesk.sh

# Windows (PowerShell as Administrator)
.\betterdesk.ps1
```

### Minimal Installation (new in v3.0)
Installs Go server only — no web console. Ideal for:
- Headless relay servers
- API-only deployments
- Lightweight edge nodes
- Custom integrations via REST API

```bash
# Linux
sudo ./betterdesk.sh --minimal

# Windows
.\betterdesk.ps1 -Minimal
```

### Docker
```bash
# Quick start (pre-built images)
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/Rustdesk-FreeConsole/main/docker-compose.quick.yml -o docker-compose.yml
docker compose up -d

# Build locally
docker compose build && docker compose up -d
```

---

## Port Reference

| Port | Protocol | Service | Mode |
|------|----------|---------|------|
| 21115 | TCP | NAT type test | Full + Minimal |
| 21116 | TCP/UDP | Signal server (client registration) | Full + Minimal |
| 21117 | TCP | Relay server (bidirectional stream) | Full + Minimal |
| 21118 | WS | WebSocket Signal | Full + Minimal |
| 21119 | WS | WebSocket Relay | Full + Minimal |
| 21121 | HTTP | Go API — REST + RustDesk client (consolidated `-api-port`) | Full + Minimal |
| 21122 | WS | CDAP Gateway | Full + Minimal (if enabled) |
| 5000 | HTTP | Web Console (LAN) | Full only |

---

## CDAP Overview

The Custom Device API Protocol (CDAP) enables non-RustDesk devices to connect to BetterDesk:

### Supported Device Types

| Type | Icon | Use Case |
|------|------|----------|
| `rustdesk` | 🖥️ | Standard RustDesk desktop client |
| `desktop` | 💻 | BetterDesk native agent (remote desktop + management) |
| `iot` | 📡 | IoT sensors and actuators |
| `scada` | 🏭 | Industrial controllers (PLC, HMI) |
| `os_agent` | 🖧 | OS-level system management agent |
| `network` | 🌐 | Network equipment (switches, routers, APs) |
| `camera` | 📷 | IP cameras and NVRs |
| `custom` | ⚙️ | Any other device type |

### Widget Types

CDAP devices expose their state through widgets rendered in the web panel:

| Widget | Description | Interactive |
|--------|-------------|-------------|
| `toggle` | Boolean switch (on/off) | ✅ |
| `gauge` | Numeric value with min/max and thresholds | ❌ |
| `button` | Action trigger with optional confirmation | ✅ |
| `led` | Status indicator (red/yellow/green) | ❌ |
| `text` | Read-only text display | ❌ |
| `slider` | Numeric range input | ✅ |
| `select` | Dropdown selection | ✅ |
| `chart` | Line/bar/area chart | ❌ |
| `table` | Dynamic sortable table | ❌ |
| `terminal` | WebSocket shell relay | ✅ |

### Authentication

CDAP clients authenticate using the same credential system as the web panel:

- **User/password** — Interactive login with optional TOTP 2FA
- **API key** — Unattended access for bridges and agents
- **Device token** — One-time enrollment for new devices

### Example: Python Bridge

```python
import asyncio
import websockets
import json

async def connect():
    uri = "ws://betterdesk.example.com:21122"
    async with websockets.connect(uri) as ws:
        # Authenticate
        await ws.send(json.dumps({
            "type": "auth",
            "payload": {
                "method": "api_key",
                "key": "your-api-key",
                "device_id": "CDAP-SENSOR01"
            }
        }))
        
        # Register with manifest
        await ws.send(json.dumps({
            "type": "register",
            "payload": {
                "manifest": {
                    "name": "Temperature Sensor",
                    "device_type": "iot",
                    "version": "1.0.0",
                    "widgets": [
                        {
                            "id": "temperature",
                            "type": "gauge",
                            "label": "Temperature",
                            "unit": "°C",
                            "min": -20,
                            "max": 80,
                            "thresholds": {
                                "warning": 60,
                                "danger": 75
                            }
                        }
                    ]
                }
            }
        }))
        
        # Send periodic state updates
        while True:
            await ws.send(json.dumps({
                "type": "state_update",
                "payload": {
                    "widgets": {
                        "temperature": {"value": 23.5}
                    }
                }
            }))
            await asyncio.sleep(5)

asyncio.run(connect())
```

---

## Security

### Encryption Layers

| Layer | Protocol | Purpose |
|-------|----------|---------|
| E2E | NaCl (XSalsa20-Poly1305) | Peer-to-peer encryption (RustDesk + CDAP media) |
| Transport | TLS 1.3 | Client-server encryption (all ports) |
| Auth | JWT + PBKDF2 + TOTP | Identity verification |
| Session | HttpOnly + Secure + SameSite cookies | Web console sessions |

### RBAC (Role-Based Access Control)

| Role | Panel | Devices | CDAP Widgets | Users | Settings |
|------|-------|---------|--------------|-------|----------|
| Admin | Full | Full | Full (incl. dangerous) | Full | Full |
| Operator | Read + most actions | Read + connect | Read + safe controls | Read own | Read |
| Viewer | Read only | Read only | Read only | None | None |

### Per-Widget RBAC (new in v3.0)

CDAP widgets can require specific roles for interaction:

```json
{
    "id": "emergency_stop",
    "type": "button",
    "label": "Emergency Stop",
    "permissions": {
        "read": "viewer",
        "execute": "admin"
    }
}
```

---

## Desktop Mode (Beta)

> ⚠️ **Beta Feature** — Desktop Mode is experimental and under active development.

Desktop Mode transforms the web console into a desktop-like interface with:
- Floating windows for each panel section
- Draggable/resizable window management
- Desktop widgets (clock, server gauges, activity feed)
- Quick launch toolbar

To enable: Click the monitor icon (🖥️) in the top navigation bar.

**Known limitations:**
- Iframe-based routing may cause session conflicts
- Some pages may not render correctly in floating windows
- Mobile devices are not supported in desktop mode
- Performance may degrade with many open windows

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 3.0.0 | 2026-03 | CDAP complete, Minimal mode, media channel, bridge SDK |
| 2.4.0 | 2026-03 | PostgreSQL support, SQLite→PG migration, Docker quick start |
| 2.3.0 | 2026-02 | Security audit, TOTP 2FA, CSRF, Client API, address book sync |
| 2.2.0 | 2026-02 | Node.js + Flask choice, migration, auto Node.js install |
| 2.1.0 | 2026-02 | Auto mode, SHA256 verification, configurable API ports |
| 2.0.0 | 2026-02 | Go server replacing Rust hbbs+hbbr, single binary |
| 1.5.0 | 2026-01 | Improved installer, diagnostics, offline status fix |
| 1.0.0 | 2025-12 | Initial release (Rust patched server + Flask console) |

---

## Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Server | Go | 1.21+ |
| Web Console | Node.js + Express.js + EJS | 18+ |
| Database | SQLite / PostgreSQL | 3.x / 14+ |
| Protocol | Protobuf (RustDesk wire format) | 3.x |
| CDAP | WebSocket + JSON | 1.0 |
| Auth | JWT + PBKDF2 + TOTP (otplib) | — |
| TLS | Go crypto/tls (1.3) | — |
| Docker | Multi-stage builds | 24+ |
| CI/CD | GitHub Actions | — |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and pull request guidelines.

See [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md) for adding new languages.

## License

GNU Affero General Public License v3.0 (AGPL-3.0) — See [LICENSE](../LICENSE) for details.
