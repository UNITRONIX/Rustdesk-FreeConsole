#!/usr/bin/env bash
# Fail if wiki source regains known stale / misleading phrases.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIKI="$ROOT/docs/wiki"
fail=0

# Patterns that should never appear as positive claims.
# Educational negations ("not mac_address", "no /api/login/2fa") are allowed.
while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  num="${rest%%:*}"
  text="${rest#*:}"
  case "$text" in
    *"not \`mac_address\`"*|*"not mac_address"*|*"no separate \`/api/login/2fa\`"*|*"no \`/api/login/2fa\`"*|*"There is **no** separate `/api/login/2fa`"*)
      continue
      ;;
  esac
  echo "FAIL stale claim in $file:$num: $text"
  fail=1
done < <(grep -RInE --include='*.md' '3\.3\.132|v2\.4\.0|mac_address|Node\.js Client API|/api/login/2fa|Node\.js 18\+|badge/Node\.js-18' "$WIKI" || true)

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "OK: wiki stale-claim checks passed"
