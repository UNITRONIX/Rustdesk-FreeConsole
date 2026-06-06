#!/bin/sh
# Waits for console auth.db before starting the Go server (SQLite Docker).
# PostgreSQL deployments skip this — panel sync uses DATABASE_URL instead.
set -e

case "${DB_URL:-}" in
    postgres://*|postgresql://*)
        exec "$@"
        ;;
esac

auth_path="${AUTH_DB_PATH:-}"
if [ -z "$auth_path" ]; then
    exec "$@"
fi

if [ ! -f "$auth_path" ]; then
    echo "Waiting for panel auth.db at $auth_path..."
    retries=0
    max_retries=90
    while [ ! -f "$auth_path" ] && [ "$retries" -lt "$max_retries" ]; do
        sleep 2
        retries=$((retries + 1))
    done
    if [ ! -f "$auth_path" ]; then
        echo "WARN: panel auth.db not found — RustDesk folders/groups may be unavailable"
    else
        echo "Panel auth.db ready: $auth_path"
    fi
fi

exec "$@"
