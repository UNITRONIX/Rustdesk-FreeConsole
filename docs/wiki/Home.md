<div align="center">

<img src="https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/betterdesk.png" alt="BetterDesk" width="280">

# BetterDesk Wiki

**RustDesk-compatible remote desktop infrastructure — Go server, Node.js console, CDAP, and browser remote.**

![Version](https://img.shields.io/badge/version-3.3.132-brightgreen.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Go](https://img.shields.io/badge/Go-1.21+-00ADD8.svg)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg)

</div>

BetterDesk replaces `hbbs` + `hbbr` with a **single Go binary**, adds a full **web management console**, optional **CDAP** for IoT/SCADA devices, and a **browser-based remote desktop** client.

> [!WARNING]
> **MGMT Client** and **Agent Client** (Tauri desktop apps) are **alpha** — not for production. Use the **Web Console** and standard **RustDesk client** in production. See [[Alpha Software Notice]].

---

## Quick Start

### Linux (bare metal)

```bash
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
sudo ./betterdesk.sh
```

Choose **1** for a new installation, or run `sudo ./betterdesk.sh --auto` for non-interactive setup.

### Docker (30 seconds)

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.yml -o docker-compose.yml
docker compose up -d
```

Open **http://your-server:5000** for the web console. Default install paths: Go server `/opt/betterdesk`, console `/opt/BetterDeskConsole` (legacy `/opt/rustdesk` is still detected by the installer).

---

## Documentation

| Topic | Page |
|-------|------|
| **Installation** | [[Installation]] — Linux, Windows, Docker |
| **Configuration** | [[Configuration]] — CLI flags, `.env`, systemd/NSSM |
| **Client setup** | [[Client Setup\|Client-Setup]] — RustDesk desktop/mobile |
| **Web console** | [[Web Console\|Web-Console]] — Dashboard, devices, settings (classic rail or optional [[UX 3.5\|UX-3.5]]) |
| **Users & RBAC** | [[User Management\|User-Management]], [[Organizations and RBAC\|Organizations-and-RBAC]] |
| **OIDC / SSO** | [[OIDC SSO\|OIDC-SSO]] |
| **Client generator** | [[Client Generator\|Client-Generator]] |
| **Fleet & policies** | [[Fleet and Policies\|Fleet-and-Policies]] |
| **Panel updates** | [[Panel Updates\|Panel-Updates]] |
| **Security** | [[Security]] — E2E, TLS, audit |
| **API** | [[API Reference\|API-Reference]] |
| **CDAP** | [[CDAP]] — IoT device protocol |
| **SDK** | [[SDK]] — Python & Node.js CDAP SDK |
| **Desktop clients** | [[Desktop Clients\|Desktop-Clients]] — MGMT, Agent, Native |
| **Web remote** | [[Web Remote Desktop\|Web-Remote]] |
| **MeshAgent** | [[MeshAgent]] — optional MeshCentral compat |
| **Docker** | [[Docker Deployment\|Docker]] |
| **TLS / SSL** | [[TLS / SSL Certificates\|TLS-SSL]] |
| **Migration** | [[Migration Guide\|Migration]] |
| **Licensing** | [[Licensing]] — AGPL-3.0 & Commercial Grant |
| **Help** | [[Troubleshooting]], [[FAQ]] |

Deep-dive developer docs live in the repository: [docs/](https://github.com/UNITRONIX/BetterDesk/tree/main/docs).

---

## Architecture Overview

```
RustDesk Desktop/Mobile Clients
  ├── UDP/TCP (:21116) ──► Signal Server ──► Registration, PunchHole, Relay
  ├── TCP     (:21117) ──► Relay Server  ──► Bidirectional relay pipe
  ├── WS      (:21118) ──► WS Signal     ──► WebSocket signal
  ├── WS      (:21119) ──► WS Relay      ──► WebSocket relay
  └── HTTP    (:21121) ──► Client API    ──► Login, AB sync, heartbeat

CDAP Agents / SDK Bridges
  └── WS/HTTP (:21122) ──► CDAP Gateway ──► Metrics, commands, widgets

Admin / Web Console
  ├── HTTP  (:21114) ──► REST API      ──► JWT / API-key auth
  ├── WS    (:21114) ──► Event Stream  ──► Real-time status push
  └── HTTP  (:5000)  ──► Web Console   ──► Node.js + Express + EJS

Optional: MeshCentral compatibility (MeshAgent KVM, terminal, files)
```

---

## Production vs Alpha

| Component | Status | Production use |
|-----------|--------|----------------|
| Go Server | Stable | Recommended |
| Web Console | Stable | Recommended |
| Native CDAP Agent (Go) | Stable | OK for deployment |
| RustDesk client (standard) | Stable | Recommended |
| MGMT Client (Tauri) | Alpha | Do not use |
| Agent Client (Tauri) | Alpha | Do not use |

---

## Links

- **Repository:** [github.com/UNITRONIX/BetterDesk](https://github.com/UNITRONIX/BetterDesk)
- **Issues:** [GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues)
- **Discussions:** [GitHub Discussions](https://github.com/UNITRONIX/BetterDesk/discussions)
- **Releases:** [GitHub Releases](https://github.com/UNITRONIX/BetterDesk/releases)
- **License:** [AGPL-3.0](https://github.com/UNITRONIX/BetterDesk/blob/main/LICENSE) — see [[Licensing]] for the optional Commercial Grant
