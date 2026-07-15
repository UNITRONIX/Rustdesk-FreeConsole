# RustDesk Client Generator

The implementation/compatibility evidence and target admission checklist are
recorded in the [RustDesk Client Generator requirements audit](REAL_CLIENT_REQUIREMENTS_AUDIT.md).

BetterDesk's RustDesk Client Generator is a native Node.js module inside the existing admin-only Agent Generator. It stores reproducible client configurations and build history in the configured BetterDesk database, while delegating expensive cross-platform RustDesk builds to a dedicated central GitHub repository.

It is intentionally separate from `agent_bundles`: an Agent bundle enrolls a BetterDesk support/agent client, while a RustDesk client build produces a branded RustDesk desktop or mobile binary from source. Existing internal identifiers retain the `real-client` prefix to keep API routes, environment variables, database records and deployed integrations backward compatible.

## Security model

- The GitHub token exists only in `REAL_CLIENT_GITHUB_TOKEN` on the BetterDesk server.
- Signing certificates, Android keystores, the payload RSA private key and the dedicated custom-config Ed25519 key exist only as GitHub repository/environment secrets.
- Provider credentials are not accepted by the browser API and are never stored in SQLite or PostgreSQL.
- A permanent RustDesk password is accepted only when a build is started. It is not saved in the configuration, returned by the API or written to logs.
- BetterDesk packages the normalized config, one-time password and uploaded PNG assets in an AES-256-GCM payload. The AES key is wrapped with RSA-OAEP-SHA256.
- GitHub receives only a random build ID, target/version identifiers and the HTTPS URL of the encrypted payload. Large images and secrets are not workflow inputs.
- BetterDesk pulls the completed GitHub Actions artifact with its server-side token. The workflow never calls a public upload endpoint.
- Download paths are private, admin-only and path-contained. Size and SHA-256 are recomputed/checked before every download, and the expected digest is shown with each artifact.

The public payload endpoint returns ciphertext only while a build is active. Payload files are removed when a build finishes, fails or is cancelled.

## One configuration, many client packages

The Agent Generator shows **RustDesk Client Generator** as a dedicated full-width action below the existing bundle actions.
That entry opens the **RustDesk Client Generator**. An administrator saves the shared server addresses and public key,
branding, icon/logo/privacy images, permissions, policy and advanced RustDesk
settings once. The build matrix then creates any E2E-verified combination in
one request:

- **Full client** uses the saved access, installation and connection-direction
  settings unchanged.
- **QuickSupport** derives an incoming-only package with a visible connection
  window, a distinct product/output name and portable installation disabled on
  platforms that support it. Android is explicitly reported as an installable
  APK rather than silently pretending to be portable.

The administrator may select one target, all verified targets, or any subset of
Windows, Linux, macOS and Android packages. The UI preflights the complete
target-by-variant matrix before dispatch, so an unsupported, non-adjustable
pair blocks the whole request before any build is queued. Platform-specific values remain in the
single saved configuration but are explicitly shown as planned adjustments
when they cannot apply to an output—for example, Android remains installable,
and Windows-only connection-manager/privacy options are omitted elsewhere.
Each accepted output becomes an independent immutable build record,
while a shared random `batch_id` groups the one-click request in history.

If a permanent password is supplied, it is entered once and copied only into
the separately encrypted one-time payload for each selected output. It is not
saved in the configuration or batch record. Assets are referenced from the
single saved configuration and securely embedded in every compatible output;
platform-specific differences are either shown as safe planned adjustments or
rejected with an exact error that must be resolved or deselected.

## Database and persistence

The normal startup migration creates the same schema for SQLite and PostgreSQL:

- `real_client_configs`: owner/organization fields, normalized config JSON, asset references, last target/provider/version/status and timestamps.
- `real_client_builds`: immutable derived config snapshot, requester, preserved owner/organization audit scope, `batch_id`, client variant, target, provider/run information, sanitized diagnostics, artifact metadata, lifecycle timestamps and retention date.

Deleting a saved configuration does not delete its audit/build history; `config_id` becomes `NULL`. Runtime secrets are never part of either JSON document.

## Central build repository contract

Use a private, dedicated RustDesk fork/build repository. Do not run untrusted customer inputs in the BetterDesk application container.

Each configured workflow must accept these `workflow_dispatch` inputs:

| Input | Meaning |
| --- | --- |
| `build_id` | BetterDesk UUID; include it in `run-name` for reliable run correlation. |
| `payload_url` | HTTPS URL of the encrypted payload. |
| `target` | Exact allow-listed target ID. Never substitute another platform/package. |
| `rustdesk_version` | `master`, `nightly` or the exact requested semantic version. |
| `source_commit` | Exact 40-character RustDesk source commit admitted for the selected version. |
| `workflow_commit` | Exact 40-character commit of the central workflow/adapter checkout. |

The workflow must:

1. Download and decrypt the payload with the repository secret `REAL_CLIENT_PAYLOAD_PRIVATE_KEY`.
2. Verify that the decrypted build ID, target and version equal the workflow inputs.
3. Sign the custom configuration with `REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY` and embed its derived public key; never remove RustDesk's signature verification.
4. Check out the exact 40-character RustDesk source commit selected by BetterDesk into an isolated directory before applying branding/config transforms; mutable branches and tags are never accepted as the final source identity.
5. Build and sign on the correct operating-system runner.
6. Publish exactly one expected package file in a GitHub Actions artifact named `real-client-<build_id>`.
7. Never print the decrypted payload, permanent password, signing material or generated config.

The scripts in [`real-client-build-repository`](../real-client-build-repository/) implement payload decryption, safe input extraction, exact source selection, custom-config signing, the concrete revision-guarded RustDesk 1.4.9 build adapter and output validation. The central fork copies these files and provisions the pinned platform toolchains/signing environments. BetterDesk remains fail-closed until both an explicit workflow mapping and an E2E-verified target/version allow-list are configured. The bundled adapter explicitly rejects the legacy Windows x86 target; an environment matrix cannot override that executable contract.

Input extraction also creates `build-plan.json`, a non-secret, allow-listed
contract for that build adapter. It preserves UTF-8 branding and the exact ID
and relay endpoints independently, including the valid case where both use
port `443`. No relay or WebSocket port is calculated from the ID port. The
plan also identifies the immutable batch and client variant so the adapter can
apply revision-tested package naming without reading secrets. The server has
already derived the QuickSupport policy overlay before encrypting the payload.
The one-time password remains only in `custom-config.json` and must never be placed
in the plan, a command line or a log.

## Server configuration

Generate a dedicated payload key pair:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out real-client-payload-private.pem
openssl pkey -in real-client-payload-private.pem -pubout -out real-client-payload-public.pem
base64 -w0 real-client-payload-public.pem
openssl genpkey -algorithm ED25519 -out real-client-custom-config-signing.pem
```

Store the RSA private PEM as `REAL_CLIENT_PAYLOAD_PRIVATE_KEY` and the Ed25519 private PEM as `REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY` in GitHub Actions secrets. Put only the RSA public PEM in BetterDesk's `REAL_CLIENT_PAYLOAD_PUBLIC_KEY`.

Configure BetterDesk:

```dotenv
REAL_CLIENT_GITHUB_TOKEN=replace-with-fine-grained-token
REAL_CLIENT_GITHUB_OWNER=example-org
REAL_CLIENT_GITHUB_REPO=rustdesk-client-builds
REAL_CLIENT_GITHUB_REF=main
REAL_CLIENT_GITHUB_WORKFLOW_COMMIT=0123456789abcdef0123456789abcdef01234567
REAL_CLIENT_GITHUB_API_URL=https://api.github.com
REAL_CLIENT_GITHUB_WORKFLOWS={"windows":"real-client-build.yml","linux":"real-client-build.yml","android":"real-client-build.yml","macos":"real-client-build.yml"}
REAL_CLIENT_PUBLIC_BASE_URL=https://console.example.com
REAL_CLIENT_PAYLOAD_PUBLIC_KEY=base64-encoded-public-pem
REAL_CLIENT_GITHUB_MATRIX={"windows-x64-exe":["1.4.9"],"windows-x64-msi":["1.4.9"]}
REAL_CLIENT_GITHUB_REVISIONS={"1.4.9":"6c578292e8ebbbec708b76986ba8c4bc7c509747"}
```

Use a fine-grained token limited to the central repository with Actions read/write permission (GitHub grants the mandatory Metadata read permission automatically). The workflow's own short-lived `GITHUB_TOKEN`, not BetterDesk's token, receives `contents: read` for checkout. Rotate the BetterDesk dispatch token independently from login/session keys.

The central repository accepts protected `betterdesk-*` runner labels for all
platforms described in the central-repository README. Linux x64 and Android
may instead use the exact ephemeral GitHub-hosted `ubuntu-22.04` image; this
fixed fallback is selected in the secret-free routing job, reclaims unrelated
preinstalled toolchains and must attest at least 40 GiB free before checkout.
Linux ARM64, Windows and macOS still require dedicated runners. A dispatch
caller can select neither the worker nor the protected environment.

Create the fixed protected environments `betterdesk-real-client-windows`,
`betterdesk-real-client-linux`, `betterdesk-real-client-flatpak`,
`betterdesk-real-client-android` and `betterdesk-real-client-macos`. The trusted
route job maps the verified target to one of these environments, so a dispatch
input cannot widen access to another platform's signing secrets.

`REAL_CLIENT_GITHUB_MATRIX` is an exact target/revision safety matrix, not a wish list. Every matrix version must have an immutable SHA in `REAL_CLIENT_GITHUB_REVISIONS`, and every target must have an explicit exact-target or platform mapping in `REAL_CLIENT_GITHUB_WORKFLOWS`; BetterDesk does not guess workflow filenames. `REAL_CLIENT_GITHUB_WORKFLOW_COMMIT` independently pins the central adapter/workflow revision. Add a pair only after that exact combination has passed build, signature, clean installation, launch, server registration, direct connection, relay connection, update/uninstall and artifact download checks. Until then it remains unavailable and cannot be built. Treat `master` and `nightly` as invalidated after every upstream change and remove their pairs from the matrix until E2E is repeated.

## RDGen compatibility mapping

The UI preserves the relevant RDGen categories: ID/relay/API/key, application/output identity, icon/logo/privacy PNG, direction, installation/settings controls, theme, approval, permissions, LAN/direct-IP behavior, connection-manager/wallpaper controls, custom features and arbitrary default/override `key=value` settings. Android application ID and macOS bundle identifier are separate validated fields; an Android identifier containing underscores is never reused as an invalid Apple signing identity.

The default source revision is the current RDGen stable release, `1.4.9`.
Mutable `master`/`nightly` builds remain an explicit opt-in and must be
re-verified whenever the upstream source changes.

Incompatible combinations are rejected or visibly warned. BetterDesk does not use RDGen's public fallback server/key, shared ZIP password, public artifact callback, mutable remote patches or transforms that remove RustDesk configuration-signature verification.

For RustDesk 1.4.9, cycle-monitor uses the upstream signed toolbar options. The offline indicator and hide-connection-manager changes are exact revision-guarded transforms. The update-notification option verifies RustDesk's native custom-client guard and deliberately preserves system-error cards. A changed upstream hunk fails the build before packaging instead of silently omitting a requested feature.

The current build contract adopts the useful resilience work from the reviewed
RDGen changes: explicit server ports, UTF-8-safe branding, Ubuntu 22.04 for the
Linux/Flatpak route, resilient handling of temporary GitHub API overloads and
automated reviewable updates for pinned Actions. It intentionally does not copy
the rigid `ID port + N` derivation, broad source replacements, mutable
`allowCustom` downloads or signing steps that ignore failures. Every optional
source workaround must match the selected RustDesk revision exactly or fail the
build before packaging.

### Reviewed RDGen pull requests

- [RDGen #117](https://github.com/bryangerlach/rdgen/pull/117): the Android workflow simplification was reviewed, but its mutable `allowCustom` verification bypass is intentionally replaced by a dedicated Ed25519 signer while RustDesk verification stays enabled.
- [RDGen #118](https://github.com/bryangerlach/rdgen/pull/118): weekly GitHub Actions dependency updates are carried into BetterDesk and the central-repository template; Actions remain pinned to immutable commits.
- [RDGen #218](https://github.com/bryangerlach/rdgen/pull/218): macOS nested-code signing and DMG lessons are part of the adapter contract, with mandatory strict verification and no ignored signing failures.
- [RDGen #237](https://github.com/bryangerlach/rdgen/pull/237): bounded network retries, Linux runner/working-directory corrections and UTF-8-safe structured branding are adopted. BetterDesk keeps ID and relay endpoints independent instead of deriving relay/WebSocket ports arithmetically.

## Local provider decision

`LocalBuildProvider` is intentionally not registered or shown. A complete RustDesk matrix requires Windows and macOS runners plus large Linux/Android toolchains, code-signing isolation, reproducible caches and cleanup. Running these toolchains inside the web-console host would widen the attack surface and make macOS builds impossible on a normal Linux server. The provider interface allows a future isolated local runner, but it should only be enabled after reproducibility and sandbox tests equivalent to the GitHub provider.

### Platform feasibility

| Platform | Required host/runner | Toolchain and system dependencies | Signing | Practical capacity | Risks, cost and maintenance | Current decision |
| --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | Ephemeral Windows Server 2022/2025 x64 worker, never the BetterDesk web host | Visual Studio 2022 C++/MSVC, Windows SDK, LLVM/Clang, Rust MSVC target, Flutter, Python, CMake/Ninja, vcpkg, NuGet/MSBuild/WiX or current RustDesk MSI tooling, ImageMagick and the portable packer | Authenticode certificate should be accessed through a protected signing service/HSM; timestamping and MSI/EXE verification are required | At least 8 vCPU, 16 GiB RAM and 80 GiB disposable SSD; cached dependency layers materially reduce 30–60 minute builds | Windows licensing, monthly image/toolchain patching, certificate custody, untrusted source-build execution and very large caches | Feasible only as an isolated Windows worker. The protected `REAL_CLIENT_RUNNER_WINDOWS_X64` label is mandatory; a 14 GiB standard runner is insufficient. |
| Windows x86 | Windows x64 worker capable of producing i686 MSVC output | Legacy Sciter path, i686 Rust target, compatible vcpkg triplets and x64 helper binaries in addition to the Windows toolchain above | Same Authenticode controls as x64 | Similar disk/RAM to x64; more cold-cache failures due to legacy dependencies | Upstream Flutter workflow does not currently advertise x86; RDGen uses a separate legacy build path that can drift or disappear | Prospective target metadata only. The current 1.4.9 adapter and provider reject it, so it is never advertised. |
| Linux x86_64/ARM64 | Ephemeral Ubuntu worker or locked container worker; native ARM64 is preferable to QEMU | Rust targets, Flutter/Flutter-elinux as applicable, Clang/LLVM, GTK3, PipeWire/PulseAudio, FFmpeg/vcpkg, CMake/Ninja, Python, DEB/AppImage/Flatpak tooling and architecture-specific containers | Optional package/repository GPG signing must use a protected key; artifact checksums are mandatory | 8 vCPU, 16 GiB RAM, 100 GiB disposable storage; ARM emulation can multiply build time | Distribution ABI spread, Flatpak runtime churn, AppImage tooling downloads, native library CVEs and multi-arch cache growth | Technically feasible in isolated Linux workers, but not inside the long-running BetterDesk container. |
| Android | Ephemeral Ubuntu worker | JDK 17 (or the exact version required by the pinned RustDesk revision), Android SDK/build-tools, NDK, Flutter, Gradle, Rust Android targets, CMake/Ninja and vcpkg Android dependencies | Dedicated Android keystore/alias/passwords in a protected environment; release APK signature must be verified after build | 8 vCPU, 16 GiB RAM and 80 GiB disposable SSD; Gradle/NDK caches are large | Keystore custody, SDK/NDK/Gradle compatibility, package-ID migration rules and three ABI outputs | Feasible as an isolated Linux worker; no local provider until worker images and signing lifecycle are versioned and tested. |
| macOS Intel/Apple Silicon | Ephemeral macOS runner on Apple hardware; Linux containers cannot produce a supported signed/notarized macOS build | Xcode/Command Line Tools, correct macOS SDK/deployment target, Rust targets, Flutter, Homebrew LLVM/CMake/Ninja/NASM, vcpkg and DMG tooling | Apple Developer ID certificate, hardened runtime, timestamping and preferably notarization/stapling; secrets belong in a protected environment/keychain | 8 vCPU, 16 GiB RAM and 80 GiB disposable SSD per architecture | Apple hardware/runner cost, Xcode image churn, certificate/profile expiration and notarization service dependencies | Not feasible on a generic BetterDesk Linux server. Use dedicated GitHub/macOS workers only. |

A future local implementation therefore needs a queue/controller plus separately registered, ephemeral workers with per-platform capability attestations. It also needs pinned worker images, source allow-lists, egress controls, CPU/RAM/disk quotas, build timeouts, signing-service separation, cache provenance, malware scanning, artifact attestations and guaranteed workspace destruction. Merely installing compilers on the BetterDesk server does not satisfy this bar.

## Artifact retention

Artifacts default to 30 days from successful build completion (`REAL_CLIENT_ARTIFACT_RETENTION_DAYS`). The same validated 1–365 day value is passed to the central workflow, so GitHub-side restart recovery and BetterDesk cleanup use one policy; the repository/organization retention limit must permit the selected value. Cleanup removes private payload/artifact files but keeps build metadata and diagnostics for audit history. Maximum extracted artifact size defaults to 750 MiB and can be adjusted with `REAL_CLIENT_MAX_ARTIFACT_BYTES`.
