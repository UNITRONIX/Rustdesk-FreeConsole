#!/bin/sh
# BetterDesk Console — Docker Entrypoint Wrapper
# Fixes volume file permissions before dropping to non-root user
set -e

# shellcheck source=/dev/null
. /ensure-app-user.sh
ensure_betterdesk_user

# Fix ownership of volume-mounted data directories.
# Docker volumes preserve UID/GID from the host or previous container,
# which may not match the betterdesk user (PUID/PGID, default 10001).
if [ "$(id -u)" = "0" ]; then
    chown -R betterdesk:betterdesk /app/data 2>/dev/null || true
    # Fix permissions on sensitive files
    if [ -f /app/data/.session_secret ]; then
        chmod 600 /app/data/.session_secret
        chown betterdesk:betterdesk /app/data/.session_secret
    fi
    if [ -f /app/data/auth.db ]; then
        chown betterdesk:betterdesk /app/data/auth.db
    fi
    # /opt/rustdesk may be mounted read-only from server volume — only fix if writable
    chown -R betterdesk:betterdesk /opt/rustdesk 2>/dev/null || true
    # Import shared bootstrap password from server volume (issue #385).
    # shellcheck source=/docker/bootstrap-admin-credentials.sh
    . /docker/bootstrap-admin-credentials.sh
    # Drop privileges and run the actual entrypoint
    exec su-exec betterdesk /app/docker-entrypoint.sh
else
    # shellcheck source=/docker/bootstrap-admin-credentials.sh
    . /docker/bootstrap-admin-credentials.sh
    exec /app/docker-entrypoint.sh
fi
