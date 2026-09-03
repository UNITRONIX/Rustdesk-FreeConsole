#!/bin/sh
# Detect stale auth.db on a fresh primary SQLite DB (issue #385).
# Partial volume wipes leave legacy auth.db in /app/data while bootstrap
# regenerates /opt/rustdesk/.admin_credentials — panel login then fails.
# Source after bootstrap-admin-credentials.sh on console / all-in-one entrypoints.
set -e

_guard_run_as_betterdesk() {
    if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1; then
        su-exec betterdesk "$@"
    else
        "$@"
    fi
}

guard_sqlite_auth_split() {
    case "${DB_TYPE:-sqlite}" in
        postgres|postgresql) return 0 ;;
    esac
    case "${DB_URL:-${DATABASE_URL:-}}" in
        postgres://*|postgresql://*) return 0 ;;
    esac

    _mode=$(printf '%s' "${SQLITE_AUTH_DB_MODE:-}" | tr '[:upper:]' '[:lower:]')
    if [ "$_mode" = "legacy" ] || [ "$_mode" = "consolidated" ]; then
        return 0
    fi

    _auth_db="${AUTH_DB_PATH:-${DATA_DIR:-/app/data}/auth.db}"
    _primary_db="${DB_PATH:-${DB_URL:-/opt/rustdesk/db_v2.sqlite3}}"

    [ -f "$_auth_db" ] || return 0
    command -v sqlite3 >/dev/null 2>&1 || return 0

    _has_consolidation_marker=0
    if [ -f "$_primary_db" ]; then
        if _guard_run_as_betterdesk sqlite3 "$_primary_db" \
            "SELECT 1 FROM betterdesk_migrations WHERE name='sqlite_auth_consolidation_v1' AND status='complete' LIMIT 1;" 2>/dev/null | grep -q 1; then
            _has_consolidation_marker=1
        fi
    fi
    [ "$_has_consolidation_marker" -eq 1 ] && return 0

    _auth_users=$(_guard_run_as_betterdesk sqlite3 "$_auth_db" \
        "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "")
    case "$_auth_users" in
        ''|*[!0-9]*) _auth_users=0 ;;
    esac

    if [ "$_auth_users" -eq 0 ]; then
        echo "WARN [#385]: Removing empty orphan auth.db ($_auth_db) — fresh installs authenticate via db_v2.sqlite3." >&2
        _guard_run_as_betterdesk rm -f "$_auth_db" "${_auth_db}-wal" "${_auth_db}-shm" 2>/dev/null || true
        return 0
    fi

    _primary_users=0
    if [ -f "$_primary_db" ]; then
        _primary_users=$(_guard_run_as_betterdesk sqlite3 "$_primary_db" \
            "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
        case "$_primary_users" in
            ''|*[!0-9]*) _primary_users=0 ;;
        esac
    fi

    if [ "$_primary_users" -eq 0 ]; then
        echo "ERROR [#385]: Split Docker volume state detected." >&2
        echo "       $_auth_db has $_auth_users user(s), but the primary database ($_primary_db) has none." >&2
        echo "       Preferred recovery for a deliberate split layout: set SQLITE_AUTH_DB_MODE=legacy" >&2
        echo "       (keeps panel accounts in auth.db; does NOT wipe data)." >&2
        echo "       Only wipe BOTH data stores on disposable test installs:" >&2
        echo "       docker compose down && rm -rf <betterdesk-data>/* <console-data>/*" >&2
        echo "       Then: ADMIN_PASSWORD='YourSecurePassword123' docker compose up -d" >&2
        echo "       Keep INIT_ADMIN_PASS / DEFAULT_ADMIN_PASSWORD mapped in compose (see docker-compose.quick.single.yml)." >&2
        echo "       Docs: docs/docker/DOCKER_TROUBLESHOOTING.md" >&2
        exit 1
    fi

    echo "WARN [#385]: Legacy auth.db present without SQLite consolidation marker." >&2
    echo "       Panel login uses $_auth_db — .admin_credentials alone may not match." >&2
    echo "       If you wiped only /opt/rustdesk, also reset /app/data or use password reset." >&2
}
