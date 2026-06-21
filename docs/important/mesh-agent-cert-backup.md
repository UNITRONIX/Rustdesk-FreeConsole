# MeshCentral agent-server certificate backup

The MeshCentral compatibility layer uses a dedicated RSA-3072 key (`MESH_AGENT_CERT_FILE`, default `mesh_agent_server.pem`).

**If this file is lost:**

1. All MeshAgents must be reinstalled or redeployed with a new `.msh` containing the new `ServerID`.
2. Generate a new key by removing the file and restarting `betterdesk-server` with `MESH_ENABLED=Y`.
3. Download fresh `.msh` from `GET /api/mesh/download.msh`.

Include `mesh_agent_server.pem` in your encrypted backup set alongside TLS certificates and `id_ed25519`.
