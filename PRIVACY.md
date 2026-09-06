# Privacy

BetterDesk is **self-hosted**. You run the server and console on machines you control. The project maintainers do not run a cloud that receives your users, sessions, or device lists.

This document describes what the open-source code does today. Forks and third-party images may differ.

## Your data stays on your server

Accounts, devices, address books, audit logs, session history, and fleet metrics live in **your** database and files (for example under `/opt/betterdesk` and `/opt/BetterDeskConsole`).

We do not operate product analytics, crash telemetry, or usage tracking for UNITRONIX. There is no Sentry, Google Analytics, Mixpanel, or similar SDK in this project.

## What “telemetry” means in the panel

Managed devices can report CPU, memory, disk, and inventory to **your** BetterDesk API (for example `/api/bd/telemetry` and CDAP heartbeats). That is for **your** operators — not for the vendor.

Sync frequency is configurable (`silent` / `standard` / `turbo` on enrollment bundles).

## What can leave your network

These calls are functional, not maintainer analytics:

| Action | Destination | Notes |
|--------|-------------|--------|
| **Check / apply updates** | GitHub API and raw content | Only when an admin uses Updates (or the install script update path). User-Agent like `BetterDesk-Console/{version}`. No machine install ID. |
| **Public IP detection** | checkip.amazonaws.com, api.ipify.org, ifconfig.me | At install/startup so relay ads can use a public address. Result stays on your server. |
| **Clock sync** | NTP (default pool.ntp.org / similar) | Configurable via `NTP_SERVERS`. |
| **Optional UI assets** | Google Fonts (branding / some pages), jsDelivr (xterm) | Main console Material Icons are self-hosted. You can avoid extra font downloads by not using branding font fetch and by firewall policy. |
| **Docker images** | ghcr.io | Normal image pull. |
| **OIDC** | Your identity provider | Only if you enable SSO. |

Help links (GitHub, Discord, Buy Me a Coffee) are ordinary links — nothing is sent until someone clicks.

## LAN discovery

The panel can advertise itself on the local network (UDP discovery and optional mDNS `_betterdesk._tcp`) with hostname, version, and panel URL. That stays on your LAN.

Disable mDNS with:

```env
PANEL_MDNS=off
```

## Desktop clients and agents

Stock RustDesk clients and Support Agents talk to **your** BetterDesk host. They do not phone home to UNITRONIX for analytics.

## Honesty

If you find phone-home behaviour we missed, please report it via [SECURITY.md](SECURITY.md) or a private security advisory — not a public issue with exploit detail.

Wiki mirror: [Privacy](https://github.com/UNITRONIX/BetterDesk/wiki/Privacy).
