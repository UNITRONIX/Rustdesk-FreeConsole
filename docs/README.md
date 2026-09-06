# Documentation

User guides live in the **[GitHub Wiki](https://github.com/UNITRONIX/BetterDesk/wiki)** (source: [`wiki/`](wiki/), sync with `scripts/sync-wiki.ps1` / `scripts/sync-wiki.sh`).

Root entry points: [README](../README.md), [PRIVACY.md](../PRIVACY.md), [CHANGELOG.md](../CHANGELOG.md).

---

## For operators

Start on the wiki: [Home](https://github.com/UNITRONIX/BetterDesk/wiki) → Installation → Client setup → TLS as needed.

Longer runbooks in this tree:

| Topic | Doc |
|-------|-----|
| Installation detail | [setup/INSTALLATION_V1.4.0.md](setup/INSTALLATION_V1.4.0.md) |
| Updates | [setup/UPDATE_GUIDE.md](setup/UPDATE_GUIDE.md) |
| HTTPS (panel) | [setup/HTTPS_SETUP.md](setup/HTTPS_SETUP.md) |
| Reverse proxy | [setup/REVERSE_PROXY.md](setup/REVERSE_PROXY.md) |
| Synology | [setup/SYNOLOGY_INSTALLATION.md](setup/SYNOLOGY_INSTALLATION.md) |
| Client mass deploy | [setup/RUSTDESK_CLIENT_DEPLOYMENT.md](setup/RUSTDESK_CLIENT_DEPLOYMENT.md) |
| Docker | [docker/DOCKER_QUICKSTART.md](docker/DOCKER_QUICKSTART.md), [docker/DOCKER_SUPPORT.md](docker/DOCKER_SUPPORT.md), [docker/DOCKER_TROUBLESHOOTING.md](docker/DOCKER_TROUBLESHOOTING.md) |
| Troubleshooting | [troubleshooting/TROUBLESHOOTING_EN.md](troubleshooting/TROUBLESHOOTING_EN.md), [troubleshooting/KEY_TROUBLESHOOTING.md](troubleshooting/KEY_TROUBLESHOOTING.md) |

---

## For developers / integrators

| Topic | Doc |
|-------|-----|
| Contributing | [development/CONTRIBUTING.md](development/CONTRIBUTING.md) |
| Translations | [development/CONTRIBUTING_TRANSLATIONS.md](development/CONTRIBUTING_TRANSLATIONS.md) |
| Build from source | [setup/BUILD_GUIDE.md](setup/BUILD_GUIDE.md) |
| Project layout | [architecture/PROJECT_STRUCTURE.md](architecture/PROJECT_STRUCTURE.md) |
| CDAP | [cdap/](cdap/), [architecture/CDAP_PROTOCOL.md](architecture/CDAP_PROTOCOL.md) |
| SDKs | [sdk/](sdk/) |
| Threat model / encryption | [security/THREAT_MODEL.md](security/THREAT_MODEL.md), [security/ENCRYPTION_SPEC.md](security/ENCRYPTION_SPEC.md) |
| Port notes | [architecture/PORT_SECURITY.md](architecture/PORT_SECURITY.md) |

Wiki mirrors for common topics: [API](https://github.com/UNITRONIX/BetterDesk/wiki/API-Reference), [CDAP](https://github.com/UNITRONIX/BetterDesk/wiki/CDAP), [SDK](https://github.com/UNITRONIX/BetterDesk/wiki/SDK).

---

## Maintainers

Branching, update flow, installer contracts: **[important/README.md](important/README.md)**.

Dated audits, roadmaps, and one-off plans are **historical** — see [archive/](archive/) when present, or treat root-level `AUDIT_*` / `*_ROADMAP_*` / `*_PLAN_*` files as non-user docs (do not link them from the wiki Home).

---

## Changelog

Use the root **[CHANGELOG.md](../CHANGELOG.md)** only. The old `development/CHANGELOG.md` file is a stub redirect.
