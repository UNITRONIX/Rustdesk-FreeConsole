# UX 3.5 — Console shell

UX 3.5 is the **default management console chrome** in BetterDesk `web-nodejs`. It replaces the TeamViewer-style icon rail / flyout and the retired Beta 3.1 iframe overlay with a **native** server-rendered layout.

## Architecture

| Piece | Path |
|-------|------|
| Layout | `web-nodejs/views/layouts/main.ejs` |
| Topbar | `web-nodejs/views/partials/ux35-topbar.ejs` |
| Sidebar (full nav + permissions) | `web-nodejs/views/partials/ux35-sidebar.ejs` |
| Tokens | `web-nodejs/public/css/ux35-tokens.css` |
| Shell CSS | `web-nodejs/public/css/ux35.css` |
| Shell JS (drawer, resize, theme icon) | `web-nodejs/public/js/ux35-shell.js` |

Navigation uses ordinary `<a href>` links (full page load). There is **no** iframe shell and **no** Modern/Classic toggle.

Out of scope for UX 3.5 (unchanged): login page, RdClient, remote viewer, CDAP Studio.

## Chrome

- **Topbar:** 48px — brand, breadcrumb (desktop), refresh, notifications, theme, accessibility, language, user menu
- **Sidebar:** default **220px** (resizable 200–320px, stored in `localStorage` key `bd_ux35_sidebar_width`)
- **Content:** padding via `--ux35-content-padding` / `--ux35-content-padding-lg` (16–24px)

## Spacing scale

Use only: **4 / 8 / 12 / 16 / 24 / 32** px (`--ux35-space-1` … `--ux35-space-6`, or `--space-xs` / `sm` / `3` / `md` / `lg` / `xl`).

Avoid ad-hoc page paddings that diverge from this scale.

## Themes

Branding `themeMode` (Settings → Branding → Colors):

| Mode | Meaning |
|------|---------|
| `dark` | Built-in dark palette |
| `light` | Built-in light palette |
| `custom` | Operator-edited colors (auto-selected when a color picker changes) |

CSS: `data-theme` / `data-theme-mode` on `<html>`, colors and glass from `/css/branding.css` (`brandingService.generateThemeCss()`).

Glass/blur tokens (`--surface-glass-*`) map onto topbar, sidebar, and cards.

## Breakpoints

| Width | Behavior |
|-------|----------|
| ≥1100px | Persistent sidebar + resize handle |
| ≤1099px | Hamburger opens sidebar drawer + overlay |
| ≤767px | Narrower drawer; content padding reduced; bottom nav retained |

## Migration from Beta 3.1

Beta 3.1 (`beta31.js` / `beta31.css`) was an optional overlay that loaded pages in `?embed=1` iframes. UX 3.5 reuses the **visual pattern** (full-list sidebar + topbar) as the native default. Desktop Mode is no longer loaded by the console layout.

## i18n

Keys under `ux35.*` and `theme.custom` exist in all 26 `web-nodejs/lang/*.json` locales. Helper script: `web-nodejs/scripts/patch-ux35-i18n.js`.

## Acceptance checklist

- [ ] Desktop 1280: sidebar + topbar + dashboard
- [ ] Tablet 1024 / 768: drawer opens/closes
- [ ] Phone 390: drawer + bottom nav
- [ ] Settings → Branding: Dark / Light / Custom + glass
- [ ] Permission-gated nav items match former sidebar
- [ ] `prefers-reduced-motion` disables content enter animation
