#!/bin/sh
# Print bootstrap admin credentials from the shared credentials file.
# Docker quick-start: .admin_credentials is mode 0600 and owned by betterdesk
# (UID from PUID, default 10001). docker compose exec runs as root, but
# cap_drop:ALL removes CAP_DAC_OVERRIDE, so root cannot read the file.
# Re-exec as betterdesk when invoked as root (issue #195).
set -e

if [ "$(id -u)" = "0" ]; then
    if command -v su-exec >/dev/null 2>&1; then
        exec su-exec betterdesk "$0" "$@"
    fi
    # All-in-one image historically lacked su-exec; busybox su works with SETUID.
    exec su -s /bin/sh betterdesk -c 'exec "$0" "$@"' -- "$0" "$@"
fi

for creds_file in /opt/rustdesk/.admin_credentials /app/data/.admin_credentials; do
    if [ -f "$creds_file" ] && [ -r "$creds_file" ]; then
        cat "$creds_file"
        exit 0
    fi
done

echo "No readable admin credentials file found." >&2
echo "  Checked: /opt/rustdesk/.admin_credentials, /app/data/.admin_credentials" >&2
echo "  Wait for first boot to finish, then retry. Or: docker compose logs server" >&2
exit 1
