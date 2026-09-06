# Troubleshooting

Common issues and their solutions.

---

## Device Status Issues

### Devices Show as Offline

**Symptoms:** All devices show "Offline" in the web console despite clients being connected.

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Go server not running | `sudo systemctl restart betterdesk-server` |
| Client pointing to wrong server | Verify ID Server address in client settings |
| Public key mismatch | Check `id_ed25519.pub` matches client config |
| Firewall blocking ports | Open 21116 TCP+UDP, 21117 TCP |
| Wrong API key | Check `.api_key` file matches `.env` `API_KEY` |

### Devices Go Offline Intermittently

**Possible causes:**
- **Strict NAT** — Enable `--always-use-relay`
- **Firewall timeout** — Reduce `PEER_TIMEOUT_SECS` or check firewall keepalive settings
- **Server resource exhaustion** — Check CPU/memory on server

### "Zombie" Devices Reappearing After Delete

This has been fixed. Signal handlers now check `IsPeerSoftDeleted()` — deleted devices cannot re-register. If you're seeing this, update to the latest version.

---

## Connection Issues

### "Failed to secure TCP: deadline has elapsed"

**Cause:** The TCP signal handler is not sending immediate responses for punch hole/relay requests.

**Solutions:**
1. Update to the latest Go server binary
2. Check TLS configuration — if using self-signed certs, ensure `--tls-api` is NOT set
3. Verify relay server IP: `curl http://your-server:21114/api/server-config`
4. If server is behind NAT, set `RELAY_SERVERS=YOUR.PUBLIC.IP`

### Relay Connections Fail

**Common causes:**

| Cause | Solution |
|-------|----------|
| Empty UUID in relay | Update Go server to current 3.5.x |
| Private IP detected | Set `RELAY_SERVERS=YOUR.PUBLIC.IP` |
| Relay port blocked | Open 21117 TCP |
| Public IP detection failed | Check `curl -4 ifconfig.me` from server |

### "client sent an HTTP request to an HTTPS server"

**Cause:** API port 21114 has TLS enabled (`--tls-api`) but Node.js console connects via HTTP.

**Solution:** Remove `--tls-api` flag, or for self-signed certs:
```bash
# Edit service file
sudo systemctl edit --full betterdesk-server
# Remove -tls-api from ExecStart
sudo systemctl restart betterdesk-server
```

---

## Web Console Issues

### 0 Devices in Panel but Dashboard Shows Count

**Cause:** Missing or mismatched API key. Dashboard uses public `/api/server/stats`, Devices uses protected `/api/peers`.

**Solution:**
```bash
# Check API key on Go server
cat /opt/betterdesk/.api_key

# Check API key in Node.js console
grep API_KEY /opt/BetterDeskConsole/.env

# They must match. If not, copy from Go server:
cp /opt/betterdesk/.api_key /opt/BetterDeskConsole/.api_key
# Update .env
sudo systemctl restart betterdesk-console
```

### Users Page Returns 401

**Cause:** Route conflict — RustDesk client API route `/api/users` (Bearer token) intercepting panel requests (session cookie).

**Solution:** Update to the current panel (3.5.x).

### Password Change Shows "Password is Required"

**Cause:** Field name mismatch — frontend sends `current_password` (snake_case), backend expects `currentPassword` (camelCase).

**Solution:** Update to the current panel (3.5.x).

### Login Page Redirects in Loop

**Possible causes:**
- Session cookie not being set (check `TRUST_PROXY` setting behind reverse proxy)
- Browser blocking cookies (SameSite policy)
- Session secret changed (all sessions invalidated)

---

## Installation Issues

### `get_public_ip: command not found`

**Cause:** Diagnostics function called undefined function in older script versions.

**Solution:** Update `betterdesk.sh` to latest version. The `get_public_ip()` function is now defined in all scripts.

### PostgreSQL Config Lost After Update

**Cause:** Older scripts overwrote `.env` with SQLite defaults during UPDATE.

**Solution:** Update install scripts to current 3.5.x. They preserve database configuration via `preserve_database_config()`.

### Auth Database Destroyed After Update

**Cause:** Older install scripts unconditionally deleted `auth.db` and regenerated admin password on every update.

**Solution:** Update to latest scripts. The fix detects existing `.env` as an update indicator and preserves auth.db.

### Password Contains `$` — Service Fails

**Cause:** systemd interprets `$` as variable substitution in service files.

**Solution:** `$` is now escaped to `$$` in service files. Re-run the installer to regenerate service files:
```bash
sudo ./betterdesk.sh
# Choose option 3 — Repair
```

### Windows: `RandomNumberGenerator::Fill` Error

**Cause:** `.NET 6+ static method unavailable in Windows PowerShell 5.1.

**Solution:** Update `betterdesk.ps1` to latest version. Fixed to use `RNGCryptoServiceProvider.GetBytes()`.

---

## Docker Issues

### Port 5000 Conflict (Single Container)

**Cause:** Go server reads generic `PORT=5000` env var (intended for Node.js) and sets signal port to 5000.

**Solution:** Ensure `SIGNAL_PORT=21116` is set in Go server environment:
```yaml
environment:
  SIGNAL_PORT: "21116"
```

### SELinux Volume Mount Denied

**Solutions:**
```bash
# Option 1: Named volumes (recommended)
volumes:
  betterdesk-data:

# Option 2: :z flag
volumes:
  - ./data:/data:z

# Option 3: Set SELinux context
sudo chcon -Rt svirt_sandbox_file_t ./data
```

### DNS Resolution Failures During Build

```bash
# Add DNS to Docker daemon
echo '{"dns": ["8.8.8.8", "8.8.4.4"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
docker compose build --no-cache
```

---

## Diagnostics

### Run Full Diagnostics

```bash
sudo ./betterdesk.sh
# Choose option 8 — Diagnostics
```

This checks:
- Service status (systemd)
- Port availability
- Database integrity
- API key consistency
- Public IP detection
- TLS certificate validity
- Disk space
- Log errors

### Manual Diagnostics

```bash
# Service status
sudo systemctl status betterdesk-server betterdesk-console

# Logs
journalctl -u betterdesk-server --since "1 hour ago" --no-pager
journalctl -u betterdesk-console --since "1 hour ago" --no-pager

# Port check
ss -tlnp | grep -E '21114|21116|21117|5000'

# API health
curl -s http://localhost:21114/api/health

# Peer count
curl -s http://localhost:21114/api/server/stats

# Public IP
curl -4 ifconfig.me
```

### Dev Diagnostics Script

```bash
./dev_modules/diagnose_offline_status.sh
```

Detailed offline status diagnostics including network, DNS, and process analysis.

---

## RustDesk Client Session Timeout (#242)

**Symptoms:** Desktop/mobile RustDesk clients lose server login after ~24 hours.

**Solution:** Update to v3.3.129+. Sessions are now DB-backed (7-day sliding, 30-day max). After updating, sign in once in each RustDesk client. Adjust TTL under **Settings → Authentication → RustDesk clients**.

---

## HTTP/HTTPS Port Confusion (#219)

**Symptoms:** After toggling HTTP/HTTPS, Go API calls fail or hit port 21121 instead of 21114.

**Cause:** Shared `.env` uses `API_PORT=21121` for the Node Client API proxy; the Go server needs `GO_API_PORT=21114`.

**Solution:** Update to latest build. Verify `betterdesk-server.service` includes `Environment=GO_API_PORT=21114`. Restart both services after toggle.

---

## Getting Help

1. Check the [GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues) for known problems
2. Run diagnostics and include the output in your bug report
3. Include Go server and Node.js console versions
4. Include relevant log output (redact sensitive data)

---

## See also

- [[FAQ]] — quick answers
- [[Configuration]] — ports and environment variables
- [[Panel Updates|Panel-Updates]] — update failures and stale banners
- [[Migration Guide|Migration]] — database migration issues
