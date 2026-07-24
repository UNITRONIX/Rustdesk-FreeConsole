# BetterDesk Server — Deployment Paths (YOUR_SERVER_IP)

> **Operator-only:** Copy this file to `docs/private/betterdesk-server-deploy-paths.md`
> (gitignored) and fill in your real host, SSH user, and paths.

## CRITICAL: Two parallel install directories may exist
- `/opt/betterdesk/betterdesk-server` ← **verify** which binary systemd uses
- Legacy paths under `/opt/betterdesk-go/` may be unused — confirm before deploy
- Always verify with: `sudo systemctl cat betterdesk-server | grep ExecStart`

## Database
- Production uses **PostgreSQL** via `-db "postgres://betterdesk:<password>@localhost:5432/betterdesk"`
- Query peers: `sudo -u postgres psql betterdesk -c "SELECT id FROM peers"`

## Deploy procedure
```
cd betterdesk-server && go build -o /tmp/betterdesk-server-new .
scp /tmp/betterdesk-server-new YOUR_SSH_USER@YOUR_SERVER_IP:/tmp/
ssh YOUR_SSH_USER@YOUR_SERVER_IP 'sudo systemctl stop betterdesk-server && \
  sudo cp /tmp/betterdesk-server-new /opt/betterdesk/betterdesk-server && \
  sudo chmod +x /opt/betterdesk/betterdesk-server && \
  sudo systemctl start betterdesk-server'
```

## Verification
- `sudo strings /opt/betterdesk/betterdesk-server | grep <unique-fix-string>`
- `sudo journalctl -u betterdesk-server --since "30 seconds ago"`
