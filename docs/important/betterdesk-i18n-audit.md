# BetterDesk i18n audit

- Strict audit command: `npm run i18n:check` from repo root; script lives at `web-nodejs/scripts/i18n-check.js`.
- Baseline is the union of EN+PL keys per system: web (`web-nodejs/lang`), agent client (`betterdesk-agent-client/src/locales`), MGMT (`betterdesk-mgmt/src/locales`).
- `i18n:fix` and `/api/panel/languages/:code/fix` are intentionally disabled to prevent English fallback values from being inserted into target locales.
- As of 2026-05-31 progress: all 26 web console locales pass strict audit (`missing=0`, `extra=0`, `empty=0`, `english=0`) and placeholder preservation check. Agent Client EN/PL/zh-TW pass; MGMT EN/PL/zh-TW pass.
