# UX 3.5 (optional beta shell)

UX 3.5 is an **optional** console chrome. The default remains the classic icon rail + flyout.

## Switch

| Want | Do |
|------|-----|
| Try UX 3.5 | Navbar shell button, or `?ui=ux35` |
| Back to classic | Topbar switch, or `?ui=classic` |
| Remember choice | Cookie `bd_ui_shell=classic` or `ux35` (1 year) |

While UX 3.5 is on, a small **BETA** chip shows in the topbar. Surfaces are **solid** (not glass/blur). Classic may still use glass accents.

## What changes for you

- Full-height sidebar list + topbar instead of icon rail
- Same pages and permissions underneath
- Help panel still opens from **Help** (supporters + links)

If something looks wrong on a phone, update the panel — several 3.5.x fixes targeted mobile topbar/tabs.

## Developers

Layout and CSS live under `web-nodejs/views/partials/ux35-*.ejs`, `public/css/ux35*.css`, `public/js/ui-shell.js`. Acceptance checklists belong in PRs, not in this operator page.

---

## See also

- [[Web Console|Web-Console]]
- [[Home]]
