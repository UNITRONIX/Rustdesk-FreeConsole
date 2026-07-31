# MeshAgent

BetterDesk includes an optional **MeshCentral compatibility layer** for managing **MeshAgent** endpoints alongside RustDesk peers.

---

## Overview

| Component | Role |
|-----------|------|
| **MeshAgent** | Lightweight agent on managed endpoints |
| **BetterCore** | Agent-side JS pushed after handshake (consent, WebRTC, terminals) |
| **BetterViewer** | Panel web remote viewer for MNG_KVM sessions (`transport=mesh`) |

Mesh is **enabled by default** on full installs (`MESH_ENABLED=Y`). Disable with `MESH_ENABLED=N` on `betterdesk-server.service` if not needed.

---

## Operator actions (panel)

For online `mesh_agent` devices, the device menu includes:

| Action | Description |
|--------|-------------|
| **Web Remote** | KVM desktop over mesh transport |
| **Terminal** | Interactive shell |
| **File browser** | Remote files |
| **Run command** | One-shot command on agent channel |
| **Guest desktop link** | Time-limited view-only URL |
| **TCP port relay** | Browser tunnel to LAN host:port |
| **Sleep / Reset** | Power commands via MeshAgent API |

Session recording: open web remote with `?record=1` for server-side `.mcrec` capture.

---

## Web remote integration

Mesh KVM sessions use the same [[Web Remote Desktop|Web-Remote]] UI with `transport=mesh`. HTTPS panel proxy must forward `.ashx` paths to the Go API (automatic with Node.js console).

---

## Enable / disable

```bash
# Check service environment
systemctl cat betterdesk-server | grep MESH

# Disable
sudo systemctl edit betterdesk-server
# Add: Environment=MESH_ENABLED=N
sudo systemctl restart betterdesk-server
```

Panel HTTPS (`:5443` or reverse proxy) should proxy MeshCentral-style paths to the **panel** (`:5000`), which forwards `.ashx` WebSockets to Go API port **21114**.

Behind an external TLS-terminating proxy, set `MESH_WEB_CERT_FILE` to the public certificate MeshAgent sees (e.g. Let's Encrypt fullchain), or leave both `MESH_WEB_CERT_FILE` and `TLS_CERT` unset to skip web-hash validation. See [MeshAgent onboarding](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/MESHAGENT_ONBOARDING.md).

---

## See also

- [[Web Remote Desktop|Web-Remote]] — browser viewer
- [[Security]] — consent prompts and audit
- [MeshAgent onboarding doc](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/MESHAGENT_ONBOARDING.md)
