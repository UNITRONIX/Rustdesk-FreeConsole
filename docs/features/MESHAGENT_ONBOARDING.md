# MeshAgent onboarding on BetterDesk

BetterDesk ships a native MeshCentral compatibility layer in `betterdesk-server` (optional module).

## BetterCore / BetterViewer

MeshAgent receives **BetterCore** (agent-side JS) after the binary handshake. The panel remote viewer uses **BetterViewer** for MNG_KVM desktop sessions (`transport=mesh`).

BetterCore includes: user **consent** prompts (desktop/terminal/files), **WebRTC** relay handoff (`webrtc0`–`webrtc2`, SDP offer/answer), and **PowerShell** terminals (`p=6` admin, `p=9` user on Windows).

## Interop CI

`betterdesk-server/meshcentral/interop/run-interop.sh` runs:

1. Simulated MeshAgent handshake (`TestAgentHandshakeInterop`) — full binary auth + BetterCore push.
2. Live MeshAgent binary (`TestMeshAgentLiveConnect`, `-tags=meshagent_live`) — downloads `meshagent_x86-64` from MeshCentral agents bundle.

GitHub Actions job `mesh-interop` in `.github/workflows/go-server-ci.yml` runs both steps on every `betterdesk-server` change.

## Enable

1. Set `MESH_ENABLED=Y` in the server environment and restart `betterdesk-server`.
2. Ensure panel HTTPS (`:5443`) proxies `.ashx` paths to the Go API port (default `21114`) — enabled automatically when using the Node.js console.

## Install endpoints

1. In the panel (or via API `GET /api/mesh/download.msh`), download the generated `.msh` file.
2. Install **unmodified** MeshAgent on Windows/Linux/macOS using that file.
3. `MeshServer` in the file points to `wss://your-host/agent.ashx`; `ServerID` pins the agent-server RSA certificate.

## Verify

- Device appears in **Devices** with `device_type: mesh_agent` and online status when connected.
- Remote desktop: open `/remote/:deviceId` — transport auto-selects `mesh`.
- API: `GET /api/peers/{id}` includes `mesh_connected: true` and `mesh_node_id`.

## Hybrid hosts (RustDesk + MeshAgent)

When MeshAgent and RustDesk client run on the same machine, BetterDesk auto-links peers by hostname when possible. Operators can also set `linked_peer_id` manually via the CDAP link API or device edit.

## Security

- Back up `MESH_AGENT_CERT_FILE` (default `mesh_agent_server.pem`). Loss requires re-enrolling all MeshAgents with a new `.msh`.
- Keep `MESH_ENABLED=N` on minimal/relay-only nodes unless MeshCentral endpoints are required.

## Update

Ships via **Settings → Updates** (panel updater) like other `betterdesk-server` and `web-nodejs` changes.
