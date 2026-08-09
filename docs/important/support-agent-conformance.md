# Support Agent conformance verification

## Current release status

**Stock-client black-box conformance: REQUIRED / MANUAL / NOT PASSED.**

GitHub Actions does not download, run, or authenticate a stock desktop client,
and it does not use a relay, BetterDesk server, signing credential, branded
bundle, or any other external test environment. The automated checks described
below validate only repository-local framing, parser, policy, and build
contracts. A successful CI run is not evidence of full desktop-client
compatibility and must not be used to make a clean-room or compatibility release
claim.

## Automated CI coverage

The `Support Agent CI` workflow runs without repository secrets:

- Linux runs `go vet ./...` and `go test -race -count=1 ./...` for
  `betterdesk-support-agent` and its shared `betterdesk-agent` dependency.
- Short, single-worker Go fuzz smoke tests exercise support-agent peer framing,
  support-agent Annex-B framing, and the shared agent's image, Annex-B, IVF,
  VP9, and AV1 framing/header readers.
- Windows and macOS run the non-race Go unit suites for both agent modules.
  Linux additionally runs the X11/Wayland capability-contract tests and Windows
  runs its capture-strategy contract. These are API/build checks, not desktop
  runtime tests.

These checks do not require a proprietary client, production credentials,
hardware capture devices, FFmpeg/GStreamer, PipeWire, an X11 display, or a
network-accessible BetterDesk service.

## Required manual black-box lab

Before any compatibility release, a release operator must run and record an
isolated black-box lab against each supported stock desktop-client version and
each supported host platform. The following scenarios remain **required and
unpassed** until their results are attached to the release record:

1. Inbound handshake and relay setup, including malformed, oversized, and
   truncated frames.
2. Authentication failure, unattended password, supervised consent, and 2FA
   acceptance/rejection behavior.
3. Desktop capture, remote input, disconnect, reconnect, and revocation while
   a session is active.
4. Capability negotiation and explicit rejection of unsupported clipboard,
   files, terminal, audio, multi-monitor, privacy, and restart operations.
5. Windows capture/input, Linux X11 capture/input, and pure-Wayland portal and
   PipeWire behavior; an unavailable capability must be reported as unavailable
   rather than silently falling back.

For every lab run, retain the client version and checksum, host OS and session
type, agent build identifier, server/relay version, tested capability set,
packet/test-vector provenance, pass/fail result, and defects found. Run the lab
with disposable credentials and data only. Do not add stock-client source,
generated artifacts, or copied test fixtures to this repository while carrying
out the black-box work.

## Release gate

CI failure blocks the release. CI success leaves the black-box gate in the
**REQUIRED / MANUAL / NOT PASSED** state until the completed lab record and the
provenance evidence required by
[`support-agent-provenance.md`](support-agent-provenance.md) are reviewed.
