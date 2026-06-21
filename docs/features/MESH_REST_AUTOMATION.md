# MeshCentral REST automation (BetterDesk)

BetterDesk operators and scripts should use the **native REST API** instead of meshctrl against a MeshCentral server.

## Device operations

| Action | Endpoint | Body |
|--------|----------|------|
| Run command | `POST /api/peers/{id}/exec` | `{"command":"whoami","shell":true}` |
| Mesh-only exec | `POST /api/mesh/devices/{id}/exec` | same |
| Power wake/sleep/off/reset | `POST /api/mesh/devices/{id}/power` | `{"action":"wake","mac":"optional"}` |
| Guest desktop link | `POST /api/mesh/devices/{id}/share` | `{"ttl_minutes":60,"view_only":true}` |
| TCP port relay tunnel | `POST /api/mesh/devices/{id}/tcp` | `{"host":"127.0.0.1","port":3389}` |
| UDP port relay tunnel | `POST /api/mesh/devices/{id}/udp` | `{"host":"127.0.0.1","port":53}` |
| Assign mesh group | `POST /api/mesh/devices/{id}/group` | `{"group_id":"default"}` |

## Inventory and settings

| Action | Endpoint |
|--------|----------|
| Mesh status | `GET /api/mesh/status` |
| Server ID | `GET /api/mesh/server-id` |
| Mesh groups | `GET/POST /api/mesh/groups` |
| Download `.msh` | `GET /api/mesh/download.msh?name=BetterDesk%20Mesh` |
| Session recordings | `GET /api/session/recordings` |
| Download mesh recording | `GET /api/mesh/recordings/{filename}` |

## Authentication

Use panel session cookies, API keys, or JWT as for other BetterDesk REST endpoints. Mesh `.ashx` WebSockets (`/agent.ashx`, `/meshrelay.ashx`, `/control.ashx`) are proxied from the panel HTTPS listener.

## Wake on LAN

When a `mesh_agent` is offline, `POST /api/mesh/devices/{id}/power` with `{"action":"wake"}` attempts Wake-on-LAN using:

1. Optional `mac` in the request body
2. MAC parsed from mesh agent telemetry (`mesh_last_msg_*`)
3. MAC from the linked RustDesk/CDAP peer (`linked_peer_id`)

## Recording

Server-side mesh KVM capture: open web remote with mesh transport and toggle **Record** (sets `record=1` on the desktop tunnel), or pass `?record=1` when opening remote. Files are stored under `{data_dir}/mesh-recordings/*.mcrec`.
