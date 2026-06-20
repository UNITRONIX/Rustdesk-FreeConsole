#!/bin/sh
# BetterDesk — All-in-One Container Entrypoint
# Runs Go server + Node.js console via supervisord
set -e

echo "========================================"
echo "  BetterDesk All-in-One Container"
echo "  Version: ${BETTERDESK_IMAGE_VERSION:-3.3.50}"
echo "========================================"
echo ""
echo "Components:"
echo "  Go Server:    signal + relay + API (ports 21115-21121)"
echo "  Node.js Console: web panel (port ${PORT:-5000})"
echo "  Client API:   port ${API_PORT:-21121}"
echo ""
echo "Configuration:"
echo "  NODE_ENV:      ${NODE_ENV:-production}"
echo "  DB_TYPE:       ${DB_TYPE:-sqlite}"
echo "  ENCRYPTED_ONLY: ${ENCRYPTED_ONLY:-1}"
echo "  DATA_DIR:      ${DATA_DIR:-/app/data}"
echo ""

# Public Docker examples use ADMIN_*; seed both the Go API and Node.js console.
if [ -n "${ADMIN_USERNAME:-}" ]; then
    if [ -z "${INIT_ADMIN_USER:-}" ]; then
        export INIT_ADMIN_USER="$ADMIN_USERNAME"
    fi
    if [ -z "${DEFAULT_ADMIN_USERNAME:-}" ]; then
        export DEFAULT_ADMIN_USERNAME="$ADMIN_USERNAME"
    fi
fi
if [ -n "${ADMIN_PASSWORD:-}" ]; then
    if [ -z "${INIT_ADMIN_PASS:-}" ]; then
        export INIT_ADMIN_PASS="$ADMIN_PASSWORD"
    fi
    if [ -z "${DEFAULT_ADMIN_PASSWORD:-}" ]; then
        export DEFAULT_ADMIN_PASSWORD="$ADMIN_PASSWORD"
    fi
fi

# Ensure data directories exist and have correct permissions
mkdir -p /opt/rustdesk /app/data /var/log/betterdesk 2>/dev/null || true
chown -R betterdesk:betterdesk /opt/rustdesk /app/data /var/log/betterdesk 2>/dev/null || true
# Verify write access — SQLite WAL mode requires writable directory (Issue #78)
if ! su -s /bin/sh betterdesk -c 'touch /opt/rustdesk/.write_test' 2>/dev/null; then
    echo ""
    echo "ERROR: /opt/rustdesk is NOT writable by the betterdesk user (UID 10001)."
    echo "  SQLite WAL mode requires write access to the database directory."
    echo "  If using bind mounts, run: chown -R 10001:10001 /path/to/your/data"
    echo "  Or use Docker named volumes instead of bind mounts."
    echo ""
fi
rm -f /opt/rustdesk/.write_test 2>/dev/null || true
# Fix private key permissions (volume mounts may preserve wrong UID/mode)
if [ -f /opt/rustdesk/id_ed25519 ]; then
    chmod 600 /opt/rustdesk/id_ed25519
    chown betterdesk:betterdesk /opt/rustdesk/id_ed25519
fi

# BD-2026-007: Warn about weak default secrets
if [ -n "${SESSION_SECRET}" ] && [ ${#SESSION_SECRET} -lt 32 ]; then
    echo "WARNING [SECURITY]: SESSION_SECRET is shorter than 32 characters — generate a stronger secret"
fi
if [ -n "${ADMIN_PASSWORD}" ] && [ ${#ADMIN_PASSWORD} -lt 12 ]; then
    echo "WARNING [SECURITY]: ADMIN_PASSWORD is shorter than 12 characters — use a stronger password"
fi

# Determine database DSN for Go server
# DB_URL env var is read by Go server's config.LoadEnv()
if [ "${DB_TYPE}" = "postgres" ] || [ "${DB_TYPE}" = "postgresql" ]; then
    if [ -n "${DATABASE_URL}" ]; then
        export DB_URL="${DATABASE_URL}"
        echo "Database:     PostgreSQL (${DATABASE_URL%%@*}@***)"
    else
        echo "WARNING: DB_TYPE=postgres but DATABASE_URL not set — falling back to SQLite"
        export DB_URL="/opt/rustdesk/db_v2.sqlite3"
    fi
else
    export DB_URL="${DB_PATH:-/opt/rustdesk/db_v2.sqlite3}"
    export AUTH_DB_PATH="${AUTH_DB_PATH:-/app/data/auth.db}"
    echo "Database:     SQLite (${DB_URL})"
    echo "Panel sync:   ${AUTH_DB_PATH}"
fi

# Wait for PostgreSQL if configured
if [ "${DB_TYPE}" = "postgres" ] || [ "${DB_TYPE}" = "postgresql" ]; then
    if [ -n "${DATABASE_URL}" ]; then
        echo "Waiting for PostgreSQL..."
        PG_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
        PG_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
        PG_PORT=${PG_PORT:-5432}
        RETRIES=0
        MAX_RETRIES=30
        while [ "$RETRIES" -lt "$MAX_RETRIES" ]; do
            if nc -z "$PG_HOST" "$PG_PORT" 2>/dev/null; then
                echo "  PostgreSQL is ready ($PG_HOST:$PG_PORT)"
                break
            fi
            RETRIES=$((RETRIES + 1))
            echo "  Waiting... ($RETRIES/$MAX_RETRIES)"
            sleep 2
        done
        if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
            echo "  WARNING: PostgreSQL not reachable — starting anyway"
        fi
    fi
fi

# Ensure Go server uses correct signal port (not NODE.js PORT)
export SIGNAL_PORT="${SIGNAL_PORT:-21116}"
export SIGNAL_RATE_LIMIT_PER_IP="${SIGNAL_RATE_LIMIT_PER_IP:-20}"

# Ensure Node.js Client API binds to all interfaces (not just localhost)
export API_HOST="${API_HOST:-0.0.0.0}"
export HOST="${HOST:-0.0.0.0}"

# Relay server address: if not explicitly set, try to auto-detect public IP.
# Inside Docker, the Go server's own detection may return the container's
# internal IP (172.x.x.x) which is unreachable by remote clients.
if [ -z "${RELAY_SERVERS:-}" ]; then
    DETECTED_IP=""
    if command -v curl >/dev/null 2>&1; then
        DETECTED_IP=$(curl -4 -sf --max-time 5 https://checkip.amazonaws.com 2>/dev/null \
            || curl -4 -sf --max-time 5 https://api.ipify.org 2>/dev/null \
            || curl -4 -sf --max-time 5 https://ifconfig.me/ip 2>/dev/null || true)
        DETECTED_IP=$(echo "$DETECTED_IP" | tr -d '[:space:]')
    fi
    if [ -n "$DETECTED_IP" ]; then
        # Verify it's not a private/Docker IP
        case "$DETECTED_IP" in
            10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*|127.*)
                echo "WARNING: Auto-detected IP ($DETECTED_IP) is private — relay may fail for remote clients."
                echo "         Set RELAY_SERVERS=YOUR.PUBLIC.IP in docker-compose.single.yml"
                ;;
            *)
                export RELAY_SERVERS="$DETECTED_IP"
                echo "Relay IP:     $DETECTED_IP (auto-detected)"
                ;;
        esac
    else
        echo "WARNING: Could not auto-detect public IP for relay."
        echo "         Set RELAY_SERVERS=YOUR.PUBLIC.IP in docker-compose.single.yml"
    fi
else
    echo "Relay IP:     $RELAY_SERVERS (from env)"
fi
export RELAY_SERVERS="${RELAY_SERVERS:-}"

# Ensure API key exists (shared between Go server and Node.js console)
API_KEY_FILE="/opt/rustdesk/.api_key"
if [ -z "${API_KEY:-}" ] && [ ! -f "$API_KEY_FILE" ]; then
    # Auto-generate a 32-byte hex API key
    if command -v openssl >/dev/null 2>&1; then
        API_KEY=$(openssl rand -hex 32)
    else
        API_KEY=$(cat /dev/urandom | head -c 32 | od -An -tx1 | tr -d ' \n')
    fi
    echo "$API_KEY" > "$API_KEY_FILE"
    chmod 600 "$API_KEY_FILE"
    chown betterdesk:betterdesk "$API_KEY_FILE" 2>/dev/null || true
    echo "Auto-generated API key → $API_KEY_FILE"
elif [ -n "${API_KEY:-}" ] && [ ! -f "$API_KEY_FILE" ]; then
    echo "$API_KEY" > "$API_KEY_FILE"
    chmod 600 "$API_KEY_FILE"
    chown betterdesk:betterdesk "$API_KEY_FILE" 2>/dev/null || true
    echo "API key from env → $API_KEY_FILE"
fi

# Default enrollment policy.
# Fresh volumes default to "managed": stock RustDesk clients are queued for
# operator approval instead of connecting silently. Pre-existing installs keep
# their current behavior (Go default "open", or whatever was set via the panel
# and persisted in the database). A volume that already contains a server key
# or SQLite database is treated as pre-existing.
if [ -z "${ENROLLMENT_MODE:-}" ]; then
    ENROLLMENT_SENTINEL="/opt/rustdesk/.enrollment_initialized"
    if [ ! -f "$ENROLLMENT_SENTINEL" ]; then
        if [ -f /opt/rustdesk/db_v2.sqlite3 ] || [ -f /opt/rustdesk/id_ed25519 ]; then
            echo "Enrollment:   preserving existing policy (pre-existing volume)"
        else
            export ENROLLMENT_MODE="managed"
            echo "Enrollment:   managed (fresh install — new devices need approval)"
        fi
        touch "$ENROLLMENT_SENTINEL" 2>/dev/null || true
        chown betterdesk:betterdesk "$ENROLLMENT_SENTINEL" 2>/dev/null || true
    fi
fi
# Always export so supervisord's %(ENV_ENROLLMENT_MODE)s interpolation resolves.
# An empty value is ignored by the Go server (keeps default/DB-restored mode).
export ENROLLMENT_MODE="${ENROLLMENT_MODE:-}"

echo ""
echo "Starting services via supervisord..."
if [ "${HTTPS_ENABLED:-false}" = "true" ]; then
    echo "  Web Console:  https://localhost:${HTTPS_PORT:-5443}"
    echo "  HTTP redirect: http://localhost:${PORT:-5000} → https://…:${HTTPS_PORT:-5443}"
else
    echo "  Web Console:  http://localhost:${PORT:-5000}"
fi
echo "  Go API:       http://localhost:21121/api"
echo "========================================"
echo ""

# Start supervisord (manages both processes)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/betterdesk.conf
