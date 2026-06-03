# Agent/MGMT client `src/lib/` gotcha

Root `.gitignore` originally had `lib/` + `lib64/` (Python distutils remnants) which silently excluded BOTH `betterdesk-agent-client/src/lib/` and `betterdesk-mgmt/src/lib/`.

These directories contain `i18n.ts` and `logger.ts` that ~13 TSX components import. They were never committed → fresh clones cannot build (vite: "Could not resolve ./lib/logger").

Fixed 2026-05-27 by changing rule to `/lib/` + `/lib64/` (root-anchored only). Created `betterdesk-agent-client/src/lib/{i18n.ts,logger.ts}` from scratch. `betterdesk-mgmt/src/lib/` still missing — same fix applies when that client is next built.

## API contracts
- `i18n.ts`: `initI18n()`, `t(key, params?)`, `setLocale(code)`, `getLocale()`, `getAvailableLocales()`, `getLocaleDisplayName(code)`, `onLocaleChange(cb)`. Bundles loaded via static JSON imports from `../locales/{en,pl,zh-TW}.json`. Locale persisted to localStorage key `betterdesk-agent-locale`.
- `logger.ts`: `frontendLog(level, scope, message, data?)` and `installFrontendErrorLogging()`. Forwards via Tauri IPC command `log_frontend_event` (defined in `src-tauri/src/commands.rs`). Payload: `{level, scope, message, data}` where data may be null.

## Build deps on Fedora
- `nodejs` + `npm` (dnf install nodejs npm — installs nodejs22)
- `libxdo-devel` (enigo crate for input injection)
- gtk3/webkit2gtk-4.1/libappindicator-gtk3/librsvg2/libsoup3 devel
- @tauri-apps/api must match tauri Rust crate minor version (mismatch errors out at build start; pin in package.json)

## Build commands
```
cd betterdesk-agent-client
npm install
npm run tauri -- build --bundles rpm   # Fedora
# Output: src-tauri/target/release/bundle/rpm/BetterDesk Agent-*.rpm
sudo dnf install -y ./BetterDesk\ Agent-*.rpm
/usr/bin/betterdesk-agent-client       # launches with tray icon
```# Agent/MGMT client `src/lib/` gotcha

Root `.gitignore` originally had `lib/` + `lib64/` (Python distutils
remnants) which silently excluded BOTH
`betterdesk-agent-client/src/lib/` and `betterdesk-mgmt/src/lib/`.

These directories contain `i18n.ts` and `logger.ts` that ~13 TSX
components import. They were never committed → fresh clones cannot
build (vite: "Could not resolve ./lib/logger").

Fixed 2026-05-27 by changing rule to `/lib/` + `/lib64/` (root-anchored
only). Created `betterdesk-agent-client/src/lib/{i18n.ts,logger.ts}`
from scratch. `betterdesk-mgmt/src/lib/` still missing — same fix
applies when that client is next built.

## API contracts
- `i18n.ts`: `initI18n()`, `t(key, params?)`, `setLocale(code)`,
  `getLocale()`, `getAvailableLocales()`, `getLocaleDisplayName(code)`,
  `onLocaleChange(cb)`. Bundles loaded via static JSON imports from
  `../locales/{en,pl,zh-TW}.json`. Locale persisted to localStorage
  key `betterdesk-agent-locale`.
- `logger.ts`: `frontendLog(level, scope, message, data?)` and
  `installFrontendErrorLogging()`. Forwards via Tauri IPC command
  `log_frontend_event` (defined in `src-tauri/src/commands.rs`).
  Payload: `{level, scope, message, data}` where data may be null.

## Build deps on Fedora
- `nodejs` + `npm` (dnf install nodejs npm — installs nodejs22)
- `libxdo-devel` (enigo crate for input injection)
- gtk3/webkit2gtk-4.1/libappindicator-gtk3/librsvg2/libsoup3 devel
- @tauri-apps/api must match tauri Rust crate minor version
  (mismatch errors out at build start; pin in package.json)

## Build commands
```
cd betterdesk-agent-client
npm install
npm run tauri -- build --bundles rpm   # Fedora
# Output: src-tauri/target/release/bundle/rpm/BetterDesk Agent-*.rpm
sudo dnf install -y ./BetterDesk\ Agent-*.rpm
/usr/bin/betterdesk-agent-client       # launches with tray icon
```
