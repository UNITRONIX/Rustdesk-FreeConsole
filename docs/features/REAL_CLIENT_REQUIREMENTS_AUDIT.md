# RustDesk Client Generator requirements audit

Audit date: 2026-07-14

This document records the implementation boundary and the evidence required
before a RustDesk target is exposed in BetterDesk. It is intentionally stricter
than accepting a successful workflow dispatch.

## Upstream baseline reviewed

- RDGen `master`: `ef21bc963c23fd1d54a3b9f69d41810105833d9b`
- RustDesk `master`: `bdb38c4730f699ae1731533c3293af28e29b5e66`
- Default stable RustDesk `1.4.9`: `6c578292e8ebbbec708b76986ba8c4bc7c509747`

RDGen's Windows x64/x86, Linux, Android and macOS workflows and its complete
form were compared with RustDesk's current build workflow. BetterDesk models
the exact package/architecture targets separately instead of treating a
platform label as proof that every output works.

## Requirement coverage

| Requirement | BetterDesk implementation | Verification gate |
| --- | --- | --- |
| Native Agent Generator UI | `RustDesk Client Generator` as a dedicated full-width action below the existing bundle actions, using BetterDesk's admin session, dialog components and styling | UI contract and route authorization tests |
| Saved configurations | Create, load, edit, duplicate and delete; timestamps, owner, organization and last-build metadata; an all-builds view keeps detached history, diagnostics and retained downloads accessible after configuration deletion | SQLite/PostgreSQL adapter and UI contract tests |
| Relevant RDGen settings | Independent ID/relay/API endpoints and ports, key, branding, URLs, Android ID, direction, installation/settings controls, theme, approval, permissions, LAN/direct IP, wallpaper/CM controls, assets and advanced maps | Normalization/compiler tests; incompatible values fail or warn explicitly |
| One-click output matrix | One saved configuration, assets and one-time password fan out into isolated Full Client and QuickSupport builds for selected verified targets | Batch preflight/lifecycle tests; maximum 30 builds and concurrency 4 |
| Unified build service | Validation, dispatch, polling, diagnostics, cancellation, artifact ingestion/download, retention and restart recovery | Service, lifecycle, route and provider tests |
| Production GitHub provider | Central repository model, explicit workflow map, exact target/version matrix, exact source SHA and exact workflow SHA; a secret-free route job selects either the fixed ephemeral hosted Linux x64/Android runner or a protected per-platform runner label | Provider remains disabled until every required BetterDesk value exists; hosted jobs must attest 40 GiB after deterministic cleanup and other targets refuse a missing/unsafe runner label before scheduling a signing job |
| Central build adapter | Concrete RustDesk 1.4.9 commands for maintained Windows x64, Linux, Android and macOS profiles; structured branding, embedded signed custom config, target packaging and signature verification | Executable adapter contract rejects other revisions and legacy Windows x86 before they can be advertised |
| Central repository admission | Clean-worktree bootstrap/check tool plus workflow preflight for exact adapter files, pinned Actions, read-only permissions and pinned vendor submodules | Admission manifest is generated before payload or signing secrets are exposed |
| Safe payload | Per-build RSA-OAEP-SHA256 + AES-256-GCM envelope; private files; no plaintext password in DB, workflow inputs, API or logs; decrypted input and the transformed source containing embedded configuration are unconditionally removed from the runner | Payload, lifecycle and central-workflow admission tests |
| Assets | Decoded/CRC-checked PNG, size/dimension limits, owner-scoped private files, per-build encrypted copy and orphan cleanup | Asset service tests |
| Artifacts | Exact workflow/build correlation, bounded ZIP download, one safe root output, extension/name/size/SHA-256 checks, private authenticated download | Provider and route tests |
| Platform signing | Windows, Android and macOS signing/notarization are mandatory; Android and Flatpak require exact signer fingerprints; Flatpak uses an ephemeral signing-only subkey; the trusted route job selects a fixed protected platform environment and mutually exclusive build steps expose only the selected platform's credentials; Windows certificates, Android keystores/properties, Flatpak keys and both temporary macOS signing/notarization keychains are always removed | Workflow and adapter fail before publication when required signing material is absent/mismatched, retained after a job, selected by dispatch input or widened to another platform step/environment |
| Local provider | Provider interface exists but no unsafe in-process build option is registered or displayed | Platform feasibility analysis in `REAL_CLIENT_GENERATOR.md` |

## Source-transform compatibility

- The third-party API delay workaround changes one exact Rust source hunk.
- RustDesk 1.4.9's native main/minimized monitor-cycle controls are enabled by
  signed settings and their source markers are verified before build.
- Offline-X and hide-connection-manager changes are exact and idempotent.
- Hide connection manager is valid only with password approval and a one-time
  permanent password supplied for the build.
- The remove-update-notification option verifies RustDesk's native custom-client
  guard; it does not hide unrelated system errors.
- Custom configuration remains Ed25519-verified. The build replaces only the
  approved verifier key inside `read_custom_client` and rejects drift.
- The signed configuration is embedded as `assets/custom.txt` and passed to
  RustDesk's existing `mainInit` verification path. Desktop service/update
  layouts also receive a correctly named `custom.txt` sidecar. The obsolete
  RDGen verification-bypass/`custom_.txt` packaging behavior is not used.
- Android and macOS identities are validated independently. The Apple bundle ID
  is never inferred from Android's underscore-compatible application ID.
- Windows MSI preprocessing keeps the safe executable/service identity separate
  from the human-visible product name; unsupported WiX XML characters fail
  validation explicitly.
- Linux ARM64 uses an exact Flutter-elinux and Flutter framework commit pair;
  RustDesk's x64-only build command/path markers are replaced exactly and the
  package architecture is set to `arm64`.

All requested transforms were applied twice (idempotency check) to the exact
RustDesk 1.4.9 source. The source diff passed `git diff --check`. This is a
source compatibility check, not a substitute for a signed platform build.

The central bootstrap was also executed against a clean RustDesk 1.4.9 Git
checkout with both pinned vendor submodules. After committing the generated
adapter files, the admission verifier accepted the clean repository, exact
vendor commits, pinned Actions and SHA-256 manifest. This proves the repository
installation contract, but still does not substitute for signed platform E2E.

## Mandatory E2E admission gate

`REAL_CLIENT_GITHUB_MATRIX` is empty by default. A target/version pair may be
added only after the central fork's `.betterdesk/build-real-client.mjs` and
runner have passed:

1. exact immutable checkout and transform;
2. clean build and required package/code-signature verification;
3. artifact contract and BetterDesk download;
4. clean install, launch and uninstall/update behavior;
5. registration against the configured ID server;
6. direct and relay sessions;
7. Full Client and QuickSupport policy/branding/password checks.

The adapter template is versioned in this BetterDesk repository and copied to
the dedicated central RustDesk build repository. Platform toolchains and
signing environments still live on its protected GitHub runners. Until those
runners and credentials are supplied and the tests above pass, BetterDesk
correctly shows the GitHub provider/targets as unavailable rather than
advertising an untested client.
