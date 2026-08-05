// Package interoperability defines the BetterDesk-owned boundary for inbound
// desktop-client wire adapters and their black-box conformance evidence.
//
// It deliberately has no imports from signalhost, betterdesk-server/codec,
// betterdesk-server/proto, or any external desktop-client schema. A future
// adapter implementation receives an already-accepted inbound transport and
// must delegate admission to SessionAuthorizer before it can use target-side
// services. The boundary exposes no dialer or controller-side workflow.
//
// No independently implemented wire adapter is registered by this package.
// The existing signalhost and protocol dependencies remain temporary audited
// compatibility surfaces; TemporaryAuditedSurfaces records their scope without
// making them dependencies of new code.
//
// The conformance harness retains only bounded, lossy wire observations. It is
// suitable for an isolated stock-client lab, not evidence of complete
// compatibility or clean-room provenance on its own.
package interoperability
