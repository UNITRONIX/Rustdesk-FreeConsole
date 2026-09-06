# Monitoring

How to watch your BetterDesk server: Prometheus metrics, health checks, and audit logs. Data stays on **your** host — see [[Privacy]].

---

## Health check

```bash
curl -s http://localhost:21114/api/health
curl -s http://localhost:21114/api/server/stats
```

Expect JSON OK / peer counts. `stats` uses the same access rules as `/metrics` (auth or allowlist).

---

## Prometheus metrics

Go serves Prometheus text on the **admin API** port:

```text
http://localhost:21114/metrics
```

Access is gated (API key / auth, or IP allowlist / public flag via `METRICS_*` env — see server config). Do not expose `/metrics` to the open internet without an allowlist.

Point Prometheus at that URL; Grafana uses a normal Prometheus datasource.

---

## Audit log

Auth and device actions land in your audit store. Review in the panel (**Audit**) or:

```bash
curl http://localhost:21114/api/audit \
  -H "X-API-Key: your-api-key"
```

---

## Panel device metrics

CPU/RAM/disk in the console come from clients reporting to **your** API. That is fleet ops, not vendor analytics. Quiet it down with enrollment sync modes — [[Privacy]].

---

## Shared NAT / CGNAT

Many peers behind one public IP: see Settings for `ALLOW_SHARED_NAT_INITIATOR` (default off) and set `MASK` / `-mask` to your real LAN CIDR (empty keeps historic `/24`). Details in 3.5.x release notes and [[Troubleshooting]].

---

## See also

- [[Configuration]]
- [[Troubleshooting]]
- [[Privacy]]
- [[Security]]
