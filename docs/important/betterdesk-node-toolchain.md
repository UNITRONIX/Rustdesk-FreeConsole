# BetterDesk Node Toolchain

- Repo validation may need Node.js, but system PATH can lack `node`/`npm`.
- Local user install used in this workspace: `~/.local/share/betterdesk-tools/node22/bin` (Node v22.11.0, npm 10.9.0).
- Use: `export PATH="$HOME/.local/share/betterdesk-tools/node22/bin:$PATH"` before `npm test`, `npm run i18n:check`, or `node --check` in `web-nodejs/`.
