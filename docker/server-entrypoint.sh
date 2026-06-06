#!/bin/sh
# BetterDesk Server — Docker Entrypoint
# Fixes volume file permissions before dropping to non-root user
set -e

DATA_DIR="/opt/rustdesk"

# SQLite Docker: wait for the console to create auth.db (folders/groups ACL).
# Skipped for PostgreSQL — panel sync uses the shared DATABASE_URL instead.
panel_auth_db_ready() {
    case "${DB_URL:-}" in
        postgres://*|postgresql://*) return 0 ;;
    esac
    auth_path="${AUTH_DB_PATH:-}"
    if [ -z "$auth_path" ]; then
        return 0
    fi
    if [ -f "$auth_path" ]; then
        echo "Panel auth.db ready: $auth_path"
        return 0
    fi
    echo "Waiting for panel auth.db at $auth_path (console container)..."
    retries=0
    max_retries=90
    while [ ! -f "$auth_path" ] && [ "$retries" -lt "$max_retries" ]; do
        sleep 2
        retries=$((retries + 1))
    done
    if [ ! -f "$auth_path" ]; then
        echo "WARN: panel auth.db not found after ${max_retries} attempts — RustDesk folders/groups may be unavailable"
        return 0
    fi
    echo "Panel auth.db ready: $auth_path"
    return 0
}
panel_auth_db_ready

# Default enrollment policy for fresh deployments.
# A volume without a server key or SQLite database is treated as a fresh
# install and defaults to "managed" (stock RustDesk clients are queued for
# operator approval). Pre-existing volumes keep their current behavior
# (Go default "open", or whatever the panel persisted in the database).
# An explicit ENROLLMENT_MODE env value always wins.
if [ -z "${ENROLLMENT_MODE:-}" ]; then
    ENROLLMENT_SENTINEL="$DATA_DIR/.enrollment_initialized"
    if [ ! -f "$ENROLLMENT_SENTINEL" ]; then
        if [ -f "$DATA_DIR/db_v2.sqlite3" ] || [ -f "$DATA_DIR/id_ed25519" ]; then
            : # pre-existing volume — keep current enrollment policy
        else
            export ENROLLMENT_MODE="managed"
            echo "Enrollment: managed (fresh install — new devices need approval)"
        fi
        touch "$ENROLLMENT_SENTINEL" 2>/dev/null || true
    fi
fi

# Fix ownership of volume-mounted data directory.
# Docker volumes preserve UID/GID from the host or previous container,
# which may not match the betterdesk user (10001) in this container.
# This is especially important for id_ed25519 (mode 600) — if owned by
# a different UID, the server cannot read the private key.
if [ "$(id -u)" = "0" ]; then
    chown -R betterdesk:betterdesk "$DATA_DIR" 2>/dev/null || true
    # Ensure private key is readable by betterdesk
    if [ -f "$DATA_DIR/id_ed25519" ]; then
        chmod 600 "$DATA_DIR/id_ed25519"
        chown betterdesk:betterdesk "$DATA_DIR/id_ed25519"
    fi
    # Drop privileges and re-exec
    exec su-exec betterdesk "$@"
else
    exec "$@"
fi
