# Important AI Notes

Notes migrated into the repository (2026-06-03) so agents and contributors have versioned, in-repo context. Original scope: external Copilot memory (`/memories/repo/`).

## Index

| File | Topic |
|------|--------|
| [betterdesk-api-port-consolidation.md](./betterdesk-api-port-consolidation.md) | **Go API :21114 (default) + Node :21121 backward-compat proxy** — issue #160, installers, client config |
| [betterdesk-go-centralization.md](./betterdesk-go-centralization.md) | Help-request + chat: agents → Go (CDAP + REST), panel as read-proxy |
| [betterdesk-server-deploy-paths.md](./betterdesk-server-deploy-paths.md) | Production deploy paths, PostgreSQL, systemd binary location |
| [betterdesk-update-flow.md](./betterdesk-update-flow.md) | Panel self-update, Go rebuild after GitHub update (#158) |
| [betterdesk-go-toolchain.md](./betterdesk-go-toolchain.md) | Go build conventions |
| [betterdesk-node-toolchain.md](./betterdesk-node-toolchain.md) | Node/npm local toolchain path |
| [betterdesk-enrollment.md](./betterdesk-enrollment.md) | Device enrollment |
| [betterdesk-i18n-audit.md](./betterdesk-i18n-audit.md) | i18n checks |
| [agent-client-roadmap-2026-05-27.md](./agent-client-roadmap-2026-05-27.md) | Agent client phases |
| [agent-build-windows-sidecar.md](./agent-build-windows-sidecar.md) | Windows agent build |
| [agent-build-worker-fix.md](./agent-build-worker-fix.md) | Agent build worker |
| [agent-client-lib-modules.md](./agent-client-lib-modules.md) | Agent lib modules |
| [installer-tui-and-protocol-tests.md](./installer-tui-and-protocol-tests.md) | Installer TUI / protocol tests |
| [installer-tui-modernization.md](./installer-tui-modernization.md) | Installer TUI UI |
| [rdclient-protobuf-enum-encoding.md](./rdclient-protobuf-enum-encoding.md) | rdclient protobuf |
| [rdclient-webcodecs-keyframe.md](./rdclient-webcodecs-keyframe.md) | WebCodecs keyframes |

When changing API ports, RustDesk client login, or console `.env`, read **betterdesk-api-port-consolidation.md** first.
