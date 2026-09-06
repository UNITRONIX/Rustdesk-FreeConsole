# Alpha software notice

> **Last updated:** 2026-09-06 (product line **3.5.x**)

Some desktop apps in this repo are still alpha. The Go server, web console, stock RustDesk clients, and Support Agent are the production path.

---

## What is ready

| Component | Status | Production |
|-----------|--------|------------|
| Go server | Stable (3.5.x) | Yes |
| Web console (Node.js 22+) | Stable (3.5.x) | Yes |
| Stock RustDesk client | Stable | Yes |
| Support Agent (Go / Wails UI) | Production path | Yes — build from [[Client Generator\|Client-Generator]] |
| Native CDAP agent (Go) | Stable | Yes for headless / IoT |
| MeshAgent compat layer | Optional (on by default) | Yes if you need it |
| MGMT Client (Tauri) | Alpha | No |
| Agent Client (Tauri) | Alpha (prefer Support Agent) | No |
| Native BetterDesk Desktop (Flutter) | Early | No |

Version numbers move with each release. Check [Releases](https://github.com/UNITRONIX/BetterDesk/releases) or **Settings → Updates** on your panel.

---

## MGMT Client (Tauri) — alpha

Operator desktop app. Incomplete remote pipeline, token refresh, bulk actions, file transfer, and cross-platform packaging. Do not deploy as your main admin UI — use the web console.

## Agent Client (Tauri) — alpha

Older endpoint app. Prefer **Support Agent** from the Client Generator for inbound support over Web Remote / CDAP.

## Native BetterDesk Desktop (Flutter)

Early operator shell added in 3.5.52. Treat as experimental until release notes say otherwise.

---

## Production stack

1. BetterDesk Go server  
2. BetterDesk web console  
3. Stock RustDesk client (1.4.7+ recommended)  
4. Optional: Support Agent and/or native CDAP agent  

---

## Reporting issues

Include: component name, OS, steps, logs (redact secrets), and panel/server version from Settings → Updates.

- [GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues)

---

## See also

- [[Desktop Clients|Desktop-Clients]]
- [[Web Console|Web-Console]]
- [[Client Generator|Client-Generator]]
- [[Home]]
