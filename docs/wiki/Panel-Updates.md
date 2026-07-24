# Panel Updates

BetterDesk can update itself through **Settings → Updates** in the web panel, or via **`betterdesk.sh` / `betterdesk.ps1`**.

---

## Native install (recommended flow)

1. Log in as **super_admin** or **server_admin**
2. Open **Settings → Updates**
3. Review available version and changelog preview
4. Run **Preflight** (checks disk space, build tools, server binary)
5. Click **Install** — panel downloads GitHub changes, merges `.env` keys, rebuilds Go server if needed, restarts services

### What is preserved

- Database files (`auth.db`, `db_v2.sqlite3`, PostgreSQL data)
- User passwords and TOTP secrets
- SSL certificates and API keys
- Operator secrets in `.env` (only **missing keys** appended from `.env.example`)

### Update channels

| Channel | Branch | Use |
|---------|--------|-----|
| **Stable** | `main` | Production (default) |
| **Development** | `dev` | Latest work-in-progress |

Switch under **Settings → Updates → Update channel**, or via installer script.

---

## Script-based update

```bash
# Linux
sudo ./betterdesk.sh   # option 2 — Update

# Windows
.\betterdesk.ps1       # option 2 — Update
```

Script updates also clear stale panel warning banners from failed in-panel attempts.

---

## Docker (GHCR images)

When running pre-built images from GHCR (`docker-compose.quick.yml`):

- In-panel **Install** is disabled — use image pull instead
- Panel shows pull instructions:

```bash
docker compose pull && docker compose up -d
```

Each console image embeds its build commit; startup syncs `data/.update_sha`.

---

## Troubleshooting updates

| Symptom | Fix |
|---------|-----|
| Red banner after successful script update | Update to latest build — banner cleared on script/Docker success (#192) |
| Go server build failed | Check preflight; use **Rebuild server binary** in Updates |
| Permission errors on `/opt/` | Run panel update as root or fix ownership |
| Stale server binary | Updates force full server source sync before compile |

---

## See also

- [[Installation]] — fresh install paths
- [[Troubleshooting]] — post-update issues
- [Update flow doc](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/important/betterdesk-update-flow.md)
