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

## Related

- Go signal handler: `betterdesk-server/signal/handler.go` (UDP `RegisterPeer`)
- HTTP heartbeat (DB only): `betterdesk-server/api/client_api_handlers.go`
- Panel mapping: `web-nodejs/services/betterdeskApi.js` (`online: !!peer.live_online`)
