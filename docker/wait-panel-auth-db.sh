#!/bin/sh
# Waits for console auth.db before starting the Go server only in explicit
# legacy mode. Fresh SQLite installs use the primary db_v2.sqlite3 database.
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

if [ ! -f "$auth_path" ] && [ "${SQLITE_AUTH_DB_MODE:-}" != "legacy" ]; then
    echo "No legacy auth.db — using the primary SQLite database."
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
