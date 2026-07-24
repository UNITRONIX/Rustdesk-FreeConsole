# RustDesk → BetterDesk server migration — client presence

## Symptom

After replacing a RustDesk Community server (hbbs/hbbr) with BetterDesk while keeping the same IP, keys, and client URLs:

- Remote sessions may work via the relay server.
- The console shows **Last seen** as recent (e.g. “6 minutes ago”).
- The **Online** badge stays **Offline** until each client is restarted.

## Why this happens

BetterDesk tracks presence in two separate channels:

| Channel | Client config | Server port | Updates | Console column |
|---------|---------------|-------------|---------|----------------|
| HTTP heartbeat | `api_server` | 21114 (`/api/heartbeat`) | DB `last_online`, DB `status` | **Last seen** |
| UDP registration | `rendezvous_server` / `id_server` | **21116** (`RegisterPeer`) | In-memory `live_online` | **Online / Offline** |

The devices table uses **`live_online`** (signal-server memory map), not the DB `status` field alone.

After migration or a BetterDesk server restart:

1. The in-memory peer table starts **empty** (`SetAllOffline()` on boot).
2. RustDesk clients often resume **HTTP** heartbeats immediately (same `api_server` URL).
3. **UDP** registration to port 21116 may stay stale until the client process or service is restarted — even when the hostname/IP did not change.

So “recent last seen + offline” is expected until clients re-register on UDP 21116.

## What to do

1. **Restart** the RustDesk client or its background service on affected machines (or reboot).
2. No need to regenerate keys if connections already work.
3. For large fleets, plan a rolling client/service restart after the server backend swap.

## Verify on the server

```bash
# Signal registration after a client restart
journalctl -u betterdesk-server -f | grep "New peer registered"

# Compare DB last seen vs live online for one peer
curl -s -H "X-API-Key: YOUR_KEY" http://127.0.0.1:21114/api/peers/DEVICE_ID | jq '{live_online, last_online, status}'
```

Checklist:

- [ ] UDP **21116** reachable from clients (firewall, NAT, Docker port mapping).
- [ ] Enrollment mode is `open`, or migrated peers already exist in the database (`managed` / `locked` can block unknown IDs).
- [ ] After restart, `live_online` becomes `true` within ~30 seconds.

## Enrollment modes

| Mode | Re-registration after migration |
|------|-------------------------------|
| `open` | Any peer with valid keys can register on UDP 21116. |
| `managed` | Peers already in the DB re-register freely; unknown IDs need approval. |
| `locked` | Only peers with a valid device token can register. |

## Manual / out-of-order migration (native install + rust2go)

Some operators install BetterDesk on a **new path** (for example `/opt/betterdesk` via `install.sh --native`), then copy keys and run `rust2go` from the old RustDesk tree (`/opt/rustdesk`). That works, but the order differs from the built-in installer path that auto-detects an existing RustDesk server directory.

### Symptom

- The web console loads and you can log in.
- Clients do **not** appear online / do not register after reboot.
- Server logs show `TestNatRequest` from client IPs, but **no** `RegisterPeer`, `RegisterPk`, or `New peer registered`.
- A test with a **new IP or hostname** works — the server itself is healthy; existing client configs are the likely gap.

`TestNatRequest` only proves partial network reachability. Full registration needs UDP `RegisterPeer` on port **21116**, then `RegisterPk`, and (for the console) HTTP heartbeats to **21114**.

### Safe checklist (no data loss)

**Before any change**, back up the server data directory:

```bash
sudo cp -a /opt/betterdesk "/opt/betterdesk-backup-$(date +%F)"
# If the old RustDesk tree still exists:
sudo cp -a /opt/rustdesk "/opt/rustdesk-backup-$(date +%F)" 2>/dev/null || true
```

Do **not** regenerate or delete `id_ed25519` / `db_v2.sqlite3` unless you intend to reconfigure every client.

#### 1. Verify the server public key

Clients must use the **same** public key as the running server:

```bash
cat /opt/betterdesk/id_ed25519.pub
```

Compare with:

- **Dashboard → RustDesk Client Configuration → Key**
- **RustDesk → Settings → Network → ID/Relay Server → Key** on one affected client

If they differ, the fresh install may have generated new keys before you copied the old ones. Restore the original `id_ed25519` and `id_ed25519.pub` from your backup, fix permissions (`600` / `644`), and restart `betterdesk-server`. See [KEY_TROUBLESHOOTING.md](KEY_TROUBLESHOOTING.md).

#### 2. Verify the migrated device database

Confirm `rust2go` imported peers into the Go database:

```bash
sqlite3 /opt/betterdesk/db_v2.sqlite3 "SELECT COUNT(*) FROM peers;"
sqlite3 /opt/betterdesk/db_v2.sqlite3 "SELECT id, hostname FROM peers LIMIT 5;"
```

If the count is `0` or expected devices are missing, re-run migration against the correct source DB:

```bash
./migrate -mode rust2go -src /opt/rustdesk/db_v2.sqlite3 -dst /opt/betterdesk/db_v2.sqlite3
sudo systemctl restart betterdesk-server
```

#### 3. Check enrollment mode

In **Settings → Enrollment mode**:

| Mode | Effect after migration |
|------|------------------------|
| `open` | Any valid client can register. |
| `managed` | Peers **already in the DB** re-register freely; unknown IDs wait in **Pending devices**. |
| `locked` | Only peers with a pre-bound device token can register. |

For a quick test on **one** machine, you can temporarily set `open`, restart the server, and retry. Revert to your preferred policy after confirming registration works.

#### 4. Check firewall / ports from a client

Clients need outbound access to the server:

| Port | Protocol | Purpose |
|------|----------|---------|
| **21116** | **UDP** + TCP | Signal / `RegisterPeer` (online status) |
| **21114** | TCP | API / heartbeat (`http://host:21114`) |
| **21117** | TCP | Relay sessions |

`TestNatRequest` can succeed over TCP while UDP **21116** is blocked — registration will still fail.

#### 5. Refresh client config (reboot alone may not be enough)

When you tested with a **new** hostname, you likely applied a fresh server config (correct key + API URL). Clients still pointing at the old hostname may keep stale settings.

On **one** test client, re-apply settings from the dashboard (**Copy deploy string**) or set manually:

- **ID Server** — your public hostname or IP
- **Relay Server** — same (or leave empty)
- **API Server** — `http://<host>:21114` (not the web panel on `:5000`)
- **Key** — contents of `id_ed25519.pub`

This does **not** change the device ID — it only refreshes server endpoints and the key.

See [RUSTDESK_CLIENT_DEPLOYMENT.md](../setup/RUSTDESK_CLIENT_DEPLOYMENT.md) for deploy-string details.

#### 6. Watch registration logs

```bash
journalctl -u betterdesk-server -f | grep -E 'RegisterPeer|RegisterPk|New peer|Enrollment|Rejected'
```

After refreshing config on one client, you should see `RegisterPeer` / `New peer registered` within ~30 seconds.

### Recommended migration order (for future cutovers)

1. **Backup** old RustDesk keys + `db_v2.sqlite3`.
2. Install BetterDesk (prefer auto-detection of `/opt/rustdesk`, or use `betterdesk.sh` → **Database migration** → `rust2go`).
3. **Verify on a temporary IP/hostname** — one client registers, console shows it online.
4. Stop the old RustDesk server; move the production IP/DNS to BetterDesk.
5. **Refresh client server config** (deploy string or GPO/RMM) — reboot alone is often insufficient after a key or API URL mismatch.

### Related

- [KEY_TROUBLESHOOTING.md](KEY_TROUBLESHOOTING.md) — key mismatch diagnosis and recovery
- [RUSTDESK_CLIENT_DEPLOYMENT.md](../setup/RUSTDESK_CLIENT_DEPLOYMENT.md) — mass client config
- Go signal handler: `betterdesk-server/signal/handler.go` (UDP `RegisterPeer`)
- HTTP heartbeat (DB only): `betterdesk-server/api/client_api_handlers.go`
- Panel mapping: `web-nodejs/services/betterdeskApi.js` (`online: !!peer.live_online`)
