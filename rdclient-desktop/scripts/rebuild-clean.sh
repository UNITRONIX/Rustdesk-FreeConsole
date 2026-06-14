#!/usr/bin/env bash
# Full rebuild of RdClient desktop (no Cargo cache).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Removing src-tauri/target (cargo cache)..."
rm -rf src-tauri/target

echo "==> npm install (if needed)..."
npm install

MODE="${1:-dev}"
if [[ "$MODE" == "build" ]]; then
  echo "==> Production build (tauri build)..."
  npm run build
else
  echo "==> Dev run (tauri dev)..."
  npm run dev
fi
