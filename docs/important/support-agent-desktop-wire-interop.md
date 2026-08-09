# Support Agent desktop-client wire interoperability

## Status and scope

`betterdesk-support-agent/internal/interoperability` establishes a
BetterDesk-owned adapter contract and a lossy black-box conformance harness.
It does **not** implement a desktop-client wire protocol, register a production
adapter, or demonstrate compatibility with any stock desktop client.

The repository's automated tests exercise only independently generated,
synthetic harness inputs. No stock binary, external source, generated schema,
packet capture, credential, or relay environment is used in CI. A passing test
therefore proves only the boundary and harness behavior described here.

The current release gate remains
[Support Agent conformance verification](support-agent-conformance.md). This
document adds the implementation and lab contract needed before that manual
gate can be satisfied; it does not change its **REQUIRED / MANUAL / NOT
PASSED** status.

## Independently-owned adapter boundary

The intended path is:

```text
accepted inbound desktop transport
  -> interoperability.Adapter
  -> interoperability.SessionAuthorizer
  -> native passive session core
  -> target-side platform services
```

`Adapter` receives an already accepted `InboundTransport`, not a listener,
dialer, rendezvous configuration, or controller-side connection API. It must
present a transient `Admission` to `SessionAuthorizer` before target-side
services are used. The grant presentation is opaque and must never be retained
in an adapter result, audit event, log entry, or conformance record.

The current `signalhost`, `betterdesk-server/codec`, and
`betterdesk-server/proto` path is listed by
`TemporaryAuditedSurfaces()` as a **temporary audited compatibility surface**.
That inventory is not provenance approval and must not be used as a dependency
or implementation template for a replacement adapter. New adapter code belongs
under `betterdesk-support-agent/internal/interoperability/` and must be written
from a reviewed BetterDesk specification and the safe observations below.

No production wiring has been added yet. Wiring a placeholder adapter to the
current relay would bypass the purpose of the boundary because there is no
independently implemented parser or completed server-grant bridge for that wire
path.

## Safe observed-wire vectors

The harness models a vector as a sequence of BetterDesk semantic observations:

- vector ID and BetterDesk specification revision;
- `black_box` or `synthetic` kind;
- direction, generic phase, and bounded payload size for each step;
- an optional SHA-256 fingerprint only for independently generated synthetic
  test bytes of fixed length.

It intentionally does not model external message names, field numbers,
generated types, or raw packet bytes. For stock-client lab traffic, callers
must use `ObservationMetadataOnly`; this retains only direction, phase, and
byte count. `black_box` vectors and runs reject payload fingerprints so a
credential, nonce, or low-entropy value cannot be represented indirectly in a
release record.

`Harness.Run` checks ordered direction/phase assertions and size bounds through
the `BlackBoxProbe` interface. The resulting `RunResult` contains only the
vector identifier and lossy observations. The harness has no disk writer and
does not persist a raw payload.

Use a `synthetic` vector only for BetterDesk-generated test bytes. It cannot be
relabelled as evidence of stock-client behavior. Use a `black_box` vector only
after a lab operator has observed the scenario against a stock binary and has
recorded metadata with no client payloads retained in the repository.

## Manual stock-client lab contract

Run this contract in an isolated environment before asserting compatibility for
any desktop-client version.

1. Obtain an unmodified stock desktop client outside this repository. Record
   its product/version, download source, SHA-256, and platform. Do not commit
   the binary, source, generated artifacts, captured frames, or a copied schema.
2. Use a disposable agent host, relay/server environment, credentials, 2FA
   secret, and desktop data. Keep packet captures outside the repository and
   delete them according to the lab's retention policy after the metadata
   record is prepared.
3. Assign the run a BetterDesk specification revision and a `black_box` vector
   ID. The probe may classify each event with the generic phases
   `transport_opened`, `handshake`, `authentication`, `capability`, `desktop`,
   `input`, `rejected`, and `transport_closed`; it must record stock traffic
   with metadata-only observations.
4. Exercise, at minimum, an agent-targeted relay/handshake, failed
   authentication, 2FA acceptance and rejection where enabled, supervised
   consent, unattended access, malformed/truncated/oversized input, desktop
   output and input after authorization, unsupported-capability refusal,
   local disconnect, reconnect, and policy revocation. A failed or unavailable
   capability is a result to record, not a reason to silently mark it passed.
5. For every run, retain a release-record entry containing the vector ID and
   revision, client version/checksum, host OS and session type, agent build,
   server/relay version, enabled capabilities, tested scenario, lossy
   observation sequence, result, and defects. Do not include passwords, grants,
   2FA values, packet bytes, screenshots, clipboard contents, or private keys.
6. Repeat the applicable scenarios for every supported client version and host
   platform. A pass applies only to that exact vector, client build, platform,
   and environment; it does not establish feature parity or general
   compatibility.

The release operator must still satisfy the provenance evidence in
[Support Agent compatibility provenance](support-agent-provenance.md) and the
manual release gate in
[Support Agent conformance verification](support-agent-conformance.md).

## Implementation admission criteria

Before adding a real adapter implementation:

- publish and review a BetterDesk-owned observed-wire specification revision;
- add a safe vector and its lab record for each new behavior;
- keep the implementation free of imports from the temporary audited surfaces,
  external desktop-client source trees, and copied schemas or fixtures;
- bind every session to server authorization and the native passive-session
  policy before capture, input, or another target-side capability is enabled;
- add negative conformance coverage for malformed input, authorization failure,
  policy revocation, and capability refusal.

The first implementation should claim only the specific reviewed vector and
client/platform combinations it has passed. Do not describe it as full
desktop-client compatibility, a clean-room implementation, or independently
licensable code until the separate provenance and release gates are complete.

## Local verification

```powershell
cd betterdesk-support-agent
go test ./internal/interoperability/...
```

The tests are intentionally local and synthetic. A stock-client lab run is
manual evidence and is not replaced by this command.
