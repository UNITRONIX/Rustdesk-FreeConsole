# MeshAgent onboarding on BetterDesk

BetterDesk ships a native MeshCentral compatibility layer in `betterdesk-server` (optional module).

## BetterCore / BetterViewer

MeshAgent receives **BetterCore** (agent-side JS) after the binary handshake. The panel remote viewer uses **BetterViewer** for MNG_KVM desktop sessions (`transport=mesh`).

BetterCore includes: user **consent** prompts (desktop/terminal/files), **WebRTC** relay handoff (`webrtc0`–`webrtc2`, SDP offer/answer), **PowerShell** terminals (`p=6` admin, `p=9` user on Windows), and **TCP/UDP port relay** (`POST /api/mesh/devices/{id}/tcp` / `udp`).

## Operator actions (panel)

For online `mesh_agent` devices, the device menu includes:

- **Web Remote** — KVM desktop (`transport=mesh`)
- **Terminal** — interactive shell (`p=1`)
- **File browser** — remote files (`p=5`) or `?panel=files` on web remote
- **Run command** — one-shot `runcommands` on the agent channel
- **Guest desktop link** — time-limited view-only URL (`mesh_share` token)
- **TCP port relay** — browser tunnel to a host/port on the agent LAN
- **Sleep / Reset** — `devicepower` via MeshAgent (`POST /api/mesh/devices/{id}/power`)

Power **wake** on sleeping agents follows MeshCentral rules (other agents on the mesh send WoL); use RustDesk WoL on linked peers when a MAC is known.

Session **recording** (server-side `.mcrec` capture): open web remote with `?record=1` on the desktop tunnel request (operator session).

## Interop CI

`betterdesk-server/meshcentral/interop/run-interop.sh` runs:

1. Simulated MeshAgent handshake (`TestAgentHandshakeInterop`) — full binary auth + BetterCore push.
2. Live MeshAgent binary (`TestMeshAgentLiveConnect`, `-tags=meshagent_live`) — downloads `meshagent_x86-64` from MeshCentral agents bundle.

GitHub Actions job `mesh-interop` in `.github/workflows/go-server-ci.yml` runs both steps on every `betterdesk-server` change.

## Enable

The MeshCentral compatibility layer is **enabled by default** on full and minimal installs (`MESH_ENABLED=Y`). To disable, set `MESH_ENABLED=N` in the `betterdesk-server` service environment and restart the service.

1. Ensure panel HTTPS (`:5443`) proxies `.ashx` paths to the Go API port (default `21114`) — enabled automatically when using the Node.js console.

## Install endpoints

1. In the panel (or via API `GET /api/mesh/download.msh`), download the generated `.msh` file.
2. Install **unmodified** MeshAgent on Windows/Linux/macOS using that file.
3. `MeshServer` in the file points to `wss://your-host/agent.ashx`; `ServerID` pins the **agent-server RSA** certificate (`MESH_AGENT_CERT_FILE`) — not the public HTTPS/Let's Encrypt cert.

## Behind an external reverse proxy (Nginx / NPM / Caddy)

TLS usually terminates at the proxy. MeshAgent hashes the **public TLS cert** it sees on `MeshServer` and BetterDesk compares that to a configured web cert hash.

| Variable | Role |
|----------|------|
| `MESH_WEB_CERT_FILE` | Preferred: path to the public cert agents see (e.g. LE `fullchain.pem`). Used for mesh web-hash only. |
| `TLS_CERT` | Fallback source for web-hash when `MESH_WEB_CERT_FILE` is unset (also used for Go signal/relay TLS). |
| *(neither set)* | Web-hash validation is **skipped** (typical native “external reverse proxy” install). |

**Do not** put `mesh_agent_server.pem` in `MESH_WEB_CERT_FILE` — that is `ServerID`, not the web TLS pin.

Preferred proxy path: `wss://host/agent.ashx` → panel `:5000` (`.ashx` WebSocket proxy to Go). Direct proxy to `:21114` works if Upgrade headers are set, but still requires a matching web cert hash when validation is enabled.

If logs show `bad web cert hash` / `agent web cert hash mismatch`: mount the proxy’s leaf/fullchain into the Go container and set `MESH_WEB_CERT_FILE`, or unset both `MESH_WEB_CERT_FILE` and `TLS_CERT` to skip the check.

## Verify

- Device appears in **Devices** with `device_type: mesh_agent` and online status when connected.
- Remote desktop: open `/remote/:deviceId` — transport auto-selects `mesh`.
- API: `GET /api/peers/{id}` includes `mesh_connected: true` and `mesh_node_id`.

## Hybrid hosts (RustDesk + MeshAgent)

When MeshAgent and RustDesk client run on the same machine, BetterDesk auto-links peers by hostname when possible. Operators can also set `linked_peer_id` manually via the CDAP link API or device edit.

## Security

- Back up `MESH_AGENT_CERT_FILE` (default `mesh_agent_server.pem`). Loss requires re-enrolling all MeshAgents with a new `.msh`.
- Keep `MESH_ENABLED=N` on relay-only nodes if you explicitly disable the module; default is **on**.

## Update

Ships via **Settings → Updates** (panel updater) like other `betterdesk-server` and `web-nodejs` changes.
