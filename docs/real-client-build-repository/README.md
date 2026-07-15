# Central repository integration template

This directory provides the secure BetterDesk transport/validation boundary
and the revision-guarded RustDesk 1.4.9 build adapter. The dedicated central
RustDesk fork must still provision and continuously test the pinned platform
toolchains described below. Do not enable a target merely because these files
were copied successfully: a target/version pair becomes visible in BetterDesk
only after its real signed package passes the E2E gate.

Copy these files into the private RustDesk fork used for BetterDesk builds:

- `decrypt-payload.mjs` → `.betterdesk/decrypt-payload.mjs`
- `extract-build-input.mjs` → `.betterdesk/extract-build-input.mjs`
- `verify-source-revision.mjs` → `.betterdesk/verify-source-revision.mjs`
- `apply-source-patches.mjs` → `.betterdesk/apply-source-patches.mjs`
- `sign-custom-config.mjs` → `.betterdesk/sign-custom-config.mjs`
- `build-real-client.mjs` → `.betterdesk/build-real-client.mjs`
- `validate-output.mjs` → `.betterdesk/validate-output.mjs`
- `verify-central-repository.mjs` → `.betterdesk/verify-central-repository.mjs`
- `real-client-build.yml` → `.github/workflows/real-client-build.yml`
- `dependabot.yml` → `.github/dependabot.yml` (merge it with existing entries if the fork already has this file)

The safer installation path is the bundled bootstrap, run against a clean
private RustDesk fork:

```bash
node install-central-adapter.mjs /path/to/private-rustdesk-fork --install --init-vendors
git -C /path/to/private-rustdesk-fork diff --check
git -C /path/to/private-rustdesk-fork commit -m "Install BetterDesk RustDesk client adapter"
node install-central-adapter.mjs /path/to/private-rustdesk-fork --check
```

The installer refuses a dirty target, refuses to overwrite differing adapter
files without `--force`, pins both vendor submodules and preserves an existing
Dependabot file for an explicit merge. `--check` compares the installed files
with this BetterDesk release and runs the same admission verifier as the
workflow. The verifier requires a clean central checkout, immutable Action
references, read-only workflow permissions, all expected scripts and the exact
vendor commits before any payload/signing secret is exposed.

Configure these protected repository variables with one aggregate runner label
per build capability:

- `REAL_CLIENT_RUNNER_WINDOWS_X64`
- `REAL_CLIENT_RUNNER_LINUX_X64`
- `REAL_CLIENT_RUNNER_LINUX_ARM64`
- `REAL_CLIENT_RUNNER_ANDROID_X64`
- `REAL_CLIENT_RUNNER_MACOS_X64`
- `REAL_CLIENT_RUNNER_MACOS_ARM64`

Dedicated labels must start with `betterdesk-` and identify a reviewed,
ephemeral worker or larger GitHub runner with the operating system/architecture
required by the adapter and enough disposable storage for RustDesk, Flutter and
vcpkg. Assign a label such as `betterdesk-linux-arm64` to the corresponding
runner or runner group. Do not pass runner labels as workflow inputs.

`REAL_CLIENT_RUNNER_LINUX_X64` and `REAL_CLIENT_RUNNER_ANDROID_X64` may be left
empty to use the exact ephemeral GitHub-hosted `ubuntu-22.04` image. This
exception is hard-coded only for Linux x64 and Android. Before checkout, the
job removes unrelated preinstalled toolchains and fails unless at least 40 GiB
is actually free. A configured dedicated runner still takes precedence and
80–100 GiB remains the recommended production capacity. Linux ARM64, Windows
and macOS never fall back to the hosted x64 runner.

The workflow receives BetterDesk's configured artifact-retention period (30
days by default), validates it and uses the same value for the provider copy.
This lets restart recovery ingest a completed build after a console outage
before GitHub removes its temporary copy. Configure the repository or its
managing organization/enterprise to permit that retention period; otherwise
GitHub correctly rejects the upload instead of silently shortening recovery.

`build-real-client.mjs` owns source-revision-specific branding, official
platform build commands, signature verification and package signing. The
workflow checks the exact SHA selected by BetterDesk into an isolated
`rustdesk-source` directory and verifies its identity and clean state before
signing or transforming it. The build script accepts the input directory,
output directory and source directory in that order and produces exactly one
file with the extension requested by the target. It never performs another
mutable RustDesk source checkout and every subprocess uses an argument array
with `shell: false`.

The signed configuration is stored as `assets/custom.txt` and passed explicitly
to RustDesk's existing `mainInit(customClientConfig:)` verification path. A
revision-guarded Dart transform aborts if that exact initialization hunk drifts.
Desktop packages also receive the correctly named `custom.txt` sidecar for
service/update compatibility. The input transport file may be named
`custom_.txt`, but the packaged file is never left under that RDGen bypass-era
name; RustDesk 1.4.9 loads `custom.txt` and still verifies its Ed25519 signature.

The current concrete adapter is deliberately revision-guarded to RustDesk
`1.4.9`. Windows x86 remains in BetterDesk's prospective target contract but
is rejected by this adapter because RustDesk 1.4.9 no longer has a maintained
Flutter x86 desktop path; do not add it to `REAL_CLIENT_GITHUB_MATRIX`. A later
adapter may add it only with a separately reviewed, signed and E2E-tested
legacy profile.

The central repository must contain these immutable submodules when their
features are enabled:

- `.betterdesk/vendor/RustDeskTempTopMostWindow` at
  `53b548a5398624f7149a382000397993542ad796` for every Windows x64 build. The
  adapter always builds/signs `WindowInjection.dll`; when a custom privacy image
  is selected, it first generates `img.cpp` from the already validated private
  PNG.
- `.betterdesk/vendor/flatpak-shared-modules` at
  `7b858d89ffe3bf9ce6e0390fe72691c9c5f322d3` for Flatpak packaging.

The workflow checks submodules out recursively. No mutable RDGen patch,
callback or runtime source clone is used.

Do not copy RDGen's public callback, shared ZIP password, mutable remote-patch downloads or `allowCustom` signature-bypass patch. `sign-custom-config.mjs` keeps RustDesk verification enabled and patches only the embedded verification public key for a dedicated build-repository Ed25519 signer. Pin all actions and downloaded toolchain artifacts, and keep signing credentials in protected GitHub environments.

Set the repository variable `BETTERDESK_PAYLOAD_ORIGIN` to the exact BetterDesk HTTPS origin. Set `REAL_CLIENT_PAYLOAD_PRIVATE_KEY` and a dedicated Ed25519 PKCS#8 key named `REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY` as repository/environment secrets. Map every BetterDesk platform to `real-client-build.yml` through `REAL_CLIENT_GITHUB_WORKFLOWS`, or split the template into explicit platform workflows. Enable only E2E-tested target/revision pairs through BetterDesk's `REAL_CLIENT_GITHUB_MATRIX`.

Platform signing is fail-closed:

Each platform invokes the common adapter from a separate conditional workflow
step. Android keystore values are exposed only to the Android step, Windows and
macOS workers receive only their own imported signing identity, Flatpak receives
only its verified GPG fingerprint, and DEB/AppImage steps receive no platform
signing secret. Do not collapse these steps into one environment block.

Create these protected GitHub Environments. The trusted route job selects the
environment from the validated target; `workflow_dispatch` cannot choose it:

- `betterdesk-real-client-windows` — Windows certificate secrets/variables.
- `betterdesk-real-client-android` — Android keystore secrets/variables.
- `betterdesk-real-client-macos` — Apple certificate and notarization secrets/variables.
- `betterdesk-real-client-flatpak` — Flatpak GPG signing secret/fingerprint.
- `betterdesk-real-client-linux` — unsigned DEB/AppImage policy with no signing secret.

Apply environment protection rules and restrict deployment branches to the
pinned central build branch. Repository-level signing secrets are technically
accepted by GitHub, but environment-scoped secrets are the production model
because only the selected platform job receives access after its protection
rules pass.

- Windows runners import `REAL_CLIENT_WINDOWS_PFX_BASE64` with
  `REAL_CLIENT_WINDOWS_PFX_PASSWORD`; `REAL_CLIENT_WINDOWS_SIGN_THUMBPRINT`
  identifies the imported certificate. Every DLL/EXE and final EXE/MSI is
  verified with `signtool verify`. The 1.4.9 MSI adapter separates the safe
  executable/service name from the human-visible application name before WiX
  preprocessing. Unsupported XML metacharacters are rejected by BetterDesk
  instead of producing a malformed or misnamed installer. The cleanup manifest
  is armed before PFX import and an already-present matching certificate is
  rejected, closing the cancellation window on reusable protected runners.
- Android uses `REAL_CLIENT_ANDROID_KEYSTORE_BASE64`,
  `REAL_CLIENT_ANDROID_STORE_PASSWORD`, `REAL_CLIENT_ANDROID_KEY_ALIAS` and
  `REAL_CLIENT_ANDROID_KEY_PASSWORD`. Set the exact release-certificate
  fingerprint in `REAL_CLIENT_ANDROID_CERT_SHA256`. The temporary keystore/property file is
  private, contained in the per-build workspace, removed both in `finally` and
  by an unconditional workflow cleanup, and `apksigner` must verify both the
  APK signature and the configured signer fingerprint.
- macOS imports `REAL_CLIENT_MACOS_P12_BASE64` with
  `REAL_CLIENT_MACOS_P12_PASSWORD`. Set
  `REAL_CLIENT_MACOS_SIGN_IDENTITY`, plus the notary variables used by the
  workflow. Nested executable/framework content is signed before the app, the
  app and DMG are strictly verified, and notarization/stapling is required by
  default. The P12 is decoded only inside a private per-job directory and
  imported into an explicit temporary signing keychain; every `codesign`
  invocation is restricted to that keychain. Signing and notarization
  keychains are both unconditionally deleted after success, failure or cancel,
  including on reusable protected runners.
- DEB/AppImage have no native platform signing identity. Flatpak requires a
  dedicated, unencrypted signing-only subkey stored as Base64 in the protected
  `REAL_CLIENT_FLATPAK_GPG_PRIVATE_KEY_BASE64` secret and its exact fingerprint
  in `REAL_CLIENT_FLATPAK_GPG_KEY`. The workflow imports it into a private
  ephemeral keyring, verifies the fingerprint and removes it after the build.
  Enable a Flatpak matrix entry only after the central repository's complete
  distribution/signing policy has passed E2E.

The final unconditional cleanup removes the decrypted build workspace, the
entire transformed RustDesk source tree (which can contain the embedded signed
configuration) and temporary workspace toolchains. This applies after success,
failure or cancellation so reusable protected runners do not retain a build
password or customer branding between jobs.

The approved RustDesk 1.4.9 toolchain baseline is Rust 1.75 (macOS 1.81),
Flutter 3.24.5, cargo-ndk 3.1.2, Android NDK r28c, LLVM 15.0.6 and vcpkg commit
`120deac3062162151622ca4860575a33844ba10b`. Native Linux ARM64 additionally
uses `sony/flutter-elinux` commit
`ac5e8387cdeadece7ed747d99da24d02adb354a6`, whose checked-in framework pin is
verified as `dec2ee5c1f98f8e84a7d5380c05eb8a3d0a81668`. The adapter changes
RustDesk's hard-coded x64 output path and Flutter command through two exact
1.4.9 source markers and sets the native DEB architecture explicitly. Because
RustDesk intentionally excludes Flutter Rust Bridge outputs from Git, every
clean build installs and attests `cargo-expand` 1.0.95 and
`flutter_rust_bridge_codegen` 1.80.1, then regenerates and verifies all Rust,
Dart, macOS and iOS bridge files before compiling. Runners may be pre-provisioned or
use reviewed pinned setup actions, but the target must stay absent from the
matrix until the adapter's tool checks and a real package build succeed.

GitHub dispatches a workflow by branch or tag. Pin the commit currently resolved by that ref in `REAL_CLIENT_GITHUB_WORKFLOW_COMMIT`; the first workflow step compares it with `github.sha` and fails before checkout or secret use on any mismatch. Separately map every admitted RustDesk version to its exact 40-character source SHA through `REAL_CLIENT_GITHUB_REVISIONS`. Updating either the adapter or upstream source therefore requires a deliberate SHA update and renewed E2E approval.

See [RustDesk Client Generator](../features/REAL_CLIENT_GENERATOR.md) for the complete setup and verification gate.

## RDGen hardening carried into the build adapter

The central `.betterdesk/build-real-client.mjs` must consume the validated
`.betterdesk-build/input/build-plan.json` instead of reparsing untrusted values
inside shell commands. The plan preserves UTF-8 application/company names and
keeps the ID and relay endpoints as two independent exact `host[:port]` values.
It also exposes the validated `batchId` (when present) and `clientVariant`
(`client` or `quicksupport`) as non-secret metadata. BetterDesk has already
created the immutable target-specific configuration and QuickSupport overlay;
the adapter must use the resulting names and policy exactly and must not fetch
or invent a second configuration. A one-click matrix is still one isolated
workflow run and one artifact per selected output, all correlated by the same
batch ID.
Never infer relay, WebSocket or API ports with `ID + 1`, `ID + 2` or `ID + 3`;
configurations where both ID and relay deliberately use `:443` are valid.

Apply source patches against the exact checked-out RustDesk revision:

- A requested connection-delay workaround is `revision-guarded`. Match one
  known source hunk exactly and abort on zero or multiple matches. Never use a
  broad replacement such as changing every `!key.is_empty()` expression.
- RustDesk 1.4.9 already contains native main/minimized-toolbar monitor-cycle
  controls. BetterDesk enables their signed settings and verifies that the
  selected source revision contains both controls; it does not reapply RDGen's
  obsolete toolbar patch.
- The optional offline-X and hide-connection-manager transforms use exact,
  idempotent source hunks and abort on drift. Hide connection manager remains
  constrained to password-only approval plus a permanent password.
- A custom RustDesk client already suppresses the public update card. The
  remove-notification policy verifies that native guard instead of using the
  old broad RDGen patch, which also hid unrelated system-error diagnostics.
- Perform branding transforms through structured Node/Python file APIs with
  explicit UTF-8. Never interpolate application/company text into `sed` or a
  shell command.
- Keep RustDesk custom-config verification mandatory. Do not download a mutable
  `allowCustom` patch and do not delete the verification branch.
  `sourcePatches.customConfigVerification` is fixed to `ed25519-required` and
  the build adapter must reject every other value.
- Use Ubuntu 22.04 for the tested Linux/Flatpak path and execute package commands
  with the RustDesk source/package directory as their explicit working directory.
- Sign macOS nested frameworks, libraries and helpers before the application,
  then sign the DMG with hardened runtime and the revision-appropriate
  entitlements. `codesign --verify --deep --strict` and package verification are
  mandatory; signing steps must not use `continue-on-error`, `|| true` or an
  equivalent bypass.

BetterDesk polls GitHub Actions, so a temporary GitHub API timeout or `5xx` does
not call back into or fail the workflow. The build remains recoverable for the
provider timeout and a successful later poll clears the transient diagnostic.
Actions are pinned to immutable commit SHAs; the supplied Dependabot entry keeps
those pins reviewably updateable.

The payload download has a bounded three-minute network timeout. Source adapters
may retry transient dependency downloads, but retries must be bounded and scoped
only to network fetches. Never retry or ignore a failed source transform,
signature, package-verification or output-contract step. Cache keys must include
the lockfile and selected source revision so Cargo/Git dependencies cannot leak
between incompatible builds.
