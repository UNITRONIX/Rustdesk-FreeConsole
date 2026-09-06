# Client Branding

White-label profile for **desktop remote clients** connected to a BetterDesk server.

## Source of truth

- Stored in the **Go** API (`server_config` keys `branding_*`).
- Edited in the web console: **Main → Client Branding** (`/client-branding`).
- Distinct from **Settings → Branding** (console / RdClient appearance via `brandingService`).

## Public read API

`GET /api/branding` — no authentication (rate-limited).

Additive schema (`schema_version: 1`):

- Legacy: `company_name`, `accent_color`, `support_contact`, `colors`, `sync_modes`
- BetterDesk: `phone`, `email`, `website`, `logo` (`mime` + `data_base64` or `url`), `revision`
- `profiles.betterdesk.apply` — fields BetterDesk desktop applies
- `profiles.rustdesk.config_options` — subset safe for stock RustDesk via heartbeat

`POST /api/branding` — admin (JWT / `X-API-Key`); validates colors, logo size (≤ 512 KiB), MIME.

## Client behaviour

| Client | Path |
|--------|------|
| **BetterDesk desktop** | Polls `GET /api/branding` from the sync loop; writes LocalConfig; clears when `api-server` is removed/changed or `revision` is `0` |
| **Stock RustDesk** | Does **not** call `/api/branding`. On heartbeat, when `modified_at` (i64 ms) differs, may receive `strategy.config_options` (e.g. `display-name`). Unknown JSON fields are ignored |

## Heartbeat

`POST /api/heartbeat` returns `modified_at` as **Unix milliseconds (int64)** so RustDesk/BetterDesk strategy cursors advance. When the client cursor is stale and Client Branding has a RustDesk projection, the response includes:

```json
{
  "modified_at": 1725620400123,
  "strategy": { "config_options": { "display-name": "Acme" } }
}
```

## Related files

- Go: `betterdesk-server/api/branding_handlers.go`, `client_api_handlers.go`
- Panel: `web-nodejs/routes/client-branding.routes.js`, `views/client-branding.ejs`
- Desktop client: `BetterDesk-Client/src/hbbs_http/betterdesk.rs`, `sync.rs`
