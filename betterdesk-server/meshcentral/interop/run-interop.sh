#!/usr/bin/env bash
# Local Mesh interop: simulated agent handshake (required) + live MeshAgent binary (best-effort).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../" && pwd)"
cd "$ROOT"
echo "==> Simulated MeshAgent handshake tests"
go test ./meshcentral/... -count=1 -timeout 5m
echo "==> Live MeshAgent binary interop (best-effort)"
if go test -tags=meshagent_live ./meshcentral/... -run TestMeshAgentLiveConnect -count=1 -timeout 10m; then
  echo "Live MeshAgent interop OK"
else
  echo "Live MeshAgent interop failed — simulated tests passed; check meshagent.log in test output"
  exit 1
fi
echo "Mesh interop OK"
