# BetterDesk Server — Deployment Paths (192.168.0.110)

## CRITICAL: Two parallel install directories exist
- `/opt/rustdesk/betterdesk-server` ← **ACTUAL** binary used by systemd service
- `/opt/betterdesk-go/betterdesk-server` ← legacy/unused; DO NOT deploy here
- systemd ExecStart references `/opt/rustdesk/` and WorkingDirectory=/opt/rustdesk
- Always verify with: `sudo systemctl cat betterdesk-server | grep ExecStart`

## Database
- Production uses **PostgreSQL** via `-db "postgres://betterdesk:...@localhost:5432/betterdesk"`
- SQLite file at `/opt/betterdesk-go/data/db_v2.sqlite3` is DEAD (last touched mar 1) — ignore it
- Query peers: `sudo -u postgres psql betterdesk -c "SELECT id FROM peers"`

## Deploy procedure
```
cd betterdesk-server && go build -o /tmp/betterdesk-server-new .
scp /tmp/betterdesk-server-new unitronix@192.168.0.110:/tmp/
ssh unitronix@192.168.0.110 'sudo systemctl stop betterdesk-server && \
  sudo cp /tmp/betterdesk-server-new /opt/rustdesk/betterdesk-server && \
  sudo chmod +x /opt/rustdesk/betterdesk-server && \
  sudo systemctl start betterdesk-server'
```

## Verification
- `sudo strings /opt/rustdesk/betterdesk-server | grep <unique-fix-string>`
- `sudo journalctl -u betterdesk-server --since "30 seconds ago"`
