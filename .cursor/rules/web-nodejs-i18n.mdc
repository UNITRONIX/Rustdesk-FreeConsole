---
description: Keep web-nodejs console i18n keys in sync across all locale files
globs: web-nodejs/lang/**/*.json
alwaysApply: true
---

# web-nodejs i18n — all locales required

When adding or changing translation keys in the BetterDesk Node.js console panel:

1. **Update every locale file** in `web-nodejs/lang/*.json` (26 languages: ar, cs, da, de, en, es, fi, fr, hi, hu, id, it, ja, ko, nb, nl, pl, pt, ro, sv, th, tr, uk, vi, zh, zh-TW).
2. Use `web-nodejs/lang/en.json` as the **source of truth** for new key names and structure.
3. Never leave a key only in `en.json` / `pl.json` — missing keys fall back awkwardly in the UI.
4. After editing, verify parity: every new key under the same JSON path must exist in all locale files.
5. Provide **proper translations** for each language (not English placeholders), unless the project explicitly accepts temporary English fallbacks.

## Checklist per change

- [ ] Key added/updated in `en.json`
- [ ] Same key path updated in the other 25 locale files
- [ ] Nested objects (e.g. `generator.errors.*`) keep identical key sets across locales
