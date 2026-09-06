# Unattended access and Wake-on-LAN

Hands-off remote access needs the **right password on the peer**, not only a panel checkbox. Wake-on-LAN is separate and only works on the same LAN as the server.

---

## Unattended access (checklist)

1. **On the device** — set a permanent password in RustDesk (Security / `--password`), or use Support Agent unattended mode from the [[Client Generator|Client-Generator]].
2. **In the panel (optional)** — record schedule / notes under **Policies**. Policy rows are **inventory** today: they are **not** enforced on punch/relay connect.
3. **Org password vault (optional, #367)** — Organizations → Address Book → contact → **Set password**. Stored encrypted in your DB; authorized AB responses can include a runtime password for stock clients. Set the **same** permanent password on the workstation. Prefer `ORG_PEER_VAULT_KEY` (else JWT secret fallback).

Operators still complete the normal peer password handshake. Panel login and org membership control **who sees** the device, not passwordless connect.

---

## Wake-on-LAN

1. Device must have a known MAC (inventory / peer record).
2. In the panel: device menu → **Wake on LAN**, or use the API:

```bash
curl -X POST http://your-server:21114/api/peers/DEVICE_ID/wol \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"mac": "AA:BB:CC:DD:EE:FF"}'
```

The JSON field is **`mac`**.

**Limits:** the BetterDesk host must be on a network that can broadcast the magic packet to that NIC (typically same LAN). WoL across the internet needs your own gateway/VPN setup — BetterDesk does not tunnel WoL for you.

---

## Enrollment modes (related)

New device registration can be `open` (default), `managed` (approve or token), or `locked` (token only). Configure on the Go server / Settings. Viewer-only mobile clients may queue under managed enrollment.

---

## See also

- [[Fleet and Policies|Fleet-and-Policies]]
- [[Client Setup|Client-Setup]]
- [[API Reference|API-Reference]]
- [[Web Console|Web-Console]]
