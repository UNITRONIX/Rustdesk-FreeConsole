<div align="center">

<img src="https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/betterdesk.png" alt="BetterDesk" width="280">

# BetterDesk Wiki

Self-hosted RustDesk-compatible server (Go) plus a Node.js web console.

![Version](https://img.shields.io/badge/version-3.5.83-brightgreen.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Go](https://img.shields.io/badge/Go-1.25+-00ADD8.svg)
![Node.js](https://img.shields.io/badge/Node.js-22+-339933.svg)

</div>

One binary replaces `hbbs` + `hbbr`. The panel handles devices, users, updates, and browser remote. Optional CDAP covers IoT and custom agents.

> [!WARNING]
> The Tauri **MGMT** and **Agent** desktop apps are alpha. For production use the **web console** and a normal **RustDesk** client. See [[Alpha Software Notice]].

---

## First 15 minutes

1. Install (Linux script, Windows script, or Docker — below).
2. Open `http://your-server:5000` and sign in.
3. Copy ID / Relay / Key / API from **Settings → Server Configuration**.
4. Point a RustDesk client at those values ([[Client Setup|Client-Setup]]).
5. Optional: TLS ([[TLS / SSL Certificates|TLS-SSL]]), then [[Panel Updates|Panel-Updates]].

### Linux

```bash
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
sudo ./betterdesk.sh
```

Pick **1** for a new install, or `sudo ./betterdesk.sh --auto` for non-interactive setup.

### Docker

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.yml -o docker-compose.yml
docker compose up -d
```

Panel: **http://your-server:5000**. Default paths: Go `/opt/betterdesk`, console `/opt/BetterDeskConsole` (legacy `/opt/rustdesk` still detected).

Windows: see [[Installation]].

---

## Docs map

| Need | Page |
|------|------|
| Install | [[Installation]], [[Docker]] |
| Clients | [[Client Setup\|Client-Setup]] |
| Panel | [[Web Console\|Web-Console]], [[Panel Updates\|Panel-Updates]] |
| Config & TLS | [[Configuration]], [[TLS / SSL Certificates\|TLS-SSL]] |
| Users / SSO | [[User Management\|User-Management]], [[OIDC SSO\|OIDC-SSO]], [[LDAP / Active Directory\|LDAP-AD]] |
| Ops | [[Monitoring]], [[Unattended Access and WoL\|Unattended-and-WoL]], [[Migration]] |
| Privacy | [[Privacy]] |
| Help | [[Troubleshooting]], [[FAQ]] |
| Developers | [[API Reference\|API-Reference]], [[CDAP]], [[SDK]] |

Deep dive in the repo: [docs/](https://github.com/UNITRONIX/BetterDesk/tree/dev/docs).

---

## Ports (short)

```
Clients  → :21116 signal, :21117 relay, :21121 Client API (Go; optional Node proxy)
Panel    → :5000 console, :21114 admin REST (often localhost)
Optional → :21122 CDAP, :21118/:21119 WebSocket signal/relay
```

---

## What to run in production

| Component | Status |
|-----------|--------|
| Go server + web console | Production |
| Stock RustDesk client | Production |
| Support Agent (Go/Wails, from Generator) | Production path for inbound support |
| Native CDAP agent (Go) | OK when you need headless/IoT |
| MGMT / Agent (Tauri) | Alpha — do not use |
| Native BetterDesk Desktop (Flutter) | Early — not for production yet |

---

## Links

- [Repository](https://github.com/UNITRONIX/BetterDesk) · [Issues](https://github.com/UNITRONIX/BetterDesk/issues) · [Discussions](https://github.com/UNITRONIX/BetterDesk/discussions) · [Releases](https://github.com/UNITRONIX/BetterDesk/releases)
- [Sponsors](https://github.com/UNITRONIX/BetterDesk/blob/main/SPONSORS.md) · [[Licensing]] · [[Privacy]]
