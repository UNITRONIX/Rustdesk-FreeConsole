# Client Generator

The **BetterDesk Support Generator** in the web console builds **incoming-only** desktop installers from BetterDesk-Client portable templates. Each build injects a server-locked `custom.txt` (rendezvous, relay, API, public key). End users download from a public hub page — no manual network configuration.

Appearance (logo, colors) is **not** baked into installers. The desktop client loads branding at runtime from the Console **Client Branding API**.

---

## What you get

Each Support bundle produces portable artifacts that:

- Use BetterDesk-Client desktop binaries (AGPL)
- Force **incoming-only** (`conn-type: incoming`)
- Override server settings via signed or plain `custom.txt`
- Target Windows / Linux / macOS (x64 + ARM64 portable)

| Platform | Format |
|----------|--------|
| Windows x64 / ARM64 | Portable `.zip` |
| Linux x64 / ARM64 | Portable `.tar.gz` |
| macOS Intel / Apple Silicon | Portable `.tar.gz` |

---

## Module install (first run)

Before creating bundles, admins install the **betterdesk-support-generator** module:

1. Open **Generator**
2. Read the AGPL / incoming-only notice and click **Accept terms**
3. Click **Install from GitHub** — downloads `generator-templates-*.tar.gz` from [BetterDesk-Client](https://github.com/UNITRONIX/BetterDesk-Client) Releases (`BETTERDESK_CLIENT_REPO`, default `UNITRONIX/BetterDesk-Client`)
4. Click **Finish installation** when status is `ready`

Module data lives under:

```text
{dataDir}/modules/betterdesk-support-generator/
  state.json
  templates/          # extracted generator-templates layout + manifest.json
  custom-client-signing.seed   # optional; from env or file
```

Optional signing seed:

- Env: `BETTERDESK_CUSTOM_CLIENT_SIGNING_SEED` (base64 32-byte NaCl seed)
- Or file `custom-client-signing.seed` copied into the module dir

Without a seed, Generator writes **plain JSON** `custom.txt` (Phase A). With a seed matching the client’s embedded `.pub`, it writes **signed** base64 blobs (Phase B).

---

## Quick start

1. Log in as **admin** and finish module install
2. Open **Generator** → **New Support**
3. Enter bundle name, optional app name, confirm server / relay / API (prefilled from console defaults)
4. Select platforms and **Save**
5. Watch build status; share the download hub link (`/d/:slug`)

### Connection fields

Defaults come from `/api/generator/defaults` (`keyService` + `clientConfigHost`):

- Server host / relay host
- HTTPS toggle + API port
- Server public key (`id_ed25519.pub`)

The worker writes `custom.txt` beside the binary (or under `Contents/MacOS` on macOS) using the Support Agent example shape (`override-settings`, `conn-type: incoming`).

---

## Architecture notes

| Piece | Role |
|-------|------|
| `supportGeneratorModule.js` | Terms + GitHub template install gate |
| `customTxtBuilder.js` | Build / sign `custom.txt` (`tweetnacl`) |
| `clientTemplateWorker.js` | Queue builds, inject templates, store artifacts in `data/agent-builds/` |
| `agent_bundles` / `agent_bundle_builds` | Existing DB tables (product_type `betterdesk-support`) |

Legacy Go **Support Agent** (`betterdesk-support-agent`) and compile-on-console workers are removed. Old product types (`support-agent`, `agent`, `agent-client`, `rdclient`) normalize to `betterdesk-support` for compatibility.

---

## Security notes

- Bundles do **not** embed a shared enrollment token
- Each install registers independently; managed mode issues a `device_token` after operator approval
- Support clients are **inbound-only** — end users cannot browse or connect outbound to other devices on your infrastructure
- Prefer signed `custom.txt` in production (seed on console must match the pubkey baked into Client releases)
