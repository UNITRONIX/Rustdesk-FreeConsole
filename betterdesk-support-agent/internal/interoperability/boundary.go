package interoperability

import (
	"context"
	"errors"
	"io"
	"strings"
)

// SpecificationRevision identifies the first BetterDesk-owned observed-wire
// specification family. It is a revision label, not a claim that any external
// client's complete protocol has been implemented.
const SpecificationRevision = "bd-desktop-wire-observation/v1"

// Feature identifies a target-side operation that an adapter may request after
// inbound session authorization. Feature declarations are not evidence that a
// client version or platform supports the operation.
type Feature string

const (
	FeatureDesktop   Feature = "desktop"
	FeatureInput     Feature = "input"
	FeatureAudio     Feature = "system_audio"
	FeatureClipboard Feature = "clipboard"
	FeatureFiles     Feature = "files"
	FeatureTerminal  Feature = "terminal"
	FeatureMonitor   Feature = "multi_monitor"
	FeatureRestart   Feature = "restart"
)

// Descriptor declares the narrow, reviewable scope of a future BetterDesk
// adapter. SupportedFeatures must be backed by a reviewed vector and manual
// lab result before it is exposed in a release.
type Descriptor struct {
	ID                    string
	SpecificationRevision string
	SupportedFeatures     []Feature
}

// Validate rejects ambiguous adapter declarations before they are registered.
func (d Descriptor) Validate() error {
	if strings.TrimSpace(d.ID) == "" || strings.TrimSpace(d.SpecificationRevision) == "" {
		return ErrInvalidDescriptor
	}
	if len(d.SupportedFeatures) == 0 {
		return ErrInvalidDescriptor
	}

	seen := make(map[Feature]struct{}, len(d.SupportedFeatures))
	for _, feature := range d.SupportedFeatures {
		if !knownFeature(feature) {
			return ErrInvalidDescriptor
		}
		if _, duplicate := seen[feature]; duplicate {
			return ErrInvalidDescriptor
		}
		seen[feature] = struct{}{}
	}
	return nil
}

// InboundTransport is a transport that has already been accepted by the
// surrounding relay or listener. Its shape intentionally does not expose a
// dialer, listener, or controller-side connection workflow.
type InboundTransport interface {
	io.ReadWriteCloser

	// PeerAddress is diagnostic metadata for the accepted peer. Implementations
	// must avoid placing credentials, grant material, or packet contents here.
	PeerAddress() string
}

// Adapter is the only wire-level entry point into the native Support Agent
// session path. ServeInbound must fail closed when authorization fails and must
// not retain or log grant presentation material.
//
// Implementations belong in this package tree and must not import the legacy
// signalhost/proto surface as an implementation shortcut.
type Adapter interface {
	Descriptor() Descriptor
	ServeInbound(context.Context, InboundTransport, SessionAuthorizer) error
}

// Admission is the transient request an adapter presents to the native passive
// session path after it has identified an inbound peer. GrantPresentation is
// opaque and is intentionally excluded from all result and audit types.
type Admission struct {
	SessionID         string
	OperatorID        string
	Transport         string
	RequestedFeatures []Feature
	GrantPresentation string
}

// Validate applies the minimum boundary checks before an authorizer evaluates
// the server grant and local policy.
func (a Admission) Validate() error {
	if strings.TrimSpace(a.SessionID) == "" ||
		strings.TrimSpace(a.OperatorID) == "" ||
		strings.TrimSpace(a.Transport) == "" ||
		strings.TrimSpace(a.GrantPresentation) == "" ||
		len(a.RequestedFeatures) == 0 {
		return ErrInvalidAdmission
	}

	seen := make(map[Feature]struct{}, len(a.RequestedFeatures))
	for _, feature := range a.RequestedFeatures {
		if !knownFeature(feature) {
			return ErrInvalidAdmission
		}
		if _, duplicate := seen[feature]; duplicate {
			return ErrInvalidAdmission
		}
		seen[feature] = struct{}{}
	}
	return nil
}

// SessionAuthorizer is implemented by the native passive-session core bridge.
// It owns grant verification, local policy, consent, and session lifecycle;
// the wire adapter only asks to begin an inbound session.
type SessionAuthorizer interface {
	AuthorizeInbound(context.Context, Admission) (AuthorizedSession, error)
}

// AuthorizedSession is the non-secret, target-side result of successful
// authorization. It exposes neither grant material nor a way to initiate a
// connection to another peer.
type AuthorizedSession interface {
	ID() string
	Allows(Feature) bool
	End(context.Context, EndReason) error
}

// EndReason describes why an inbound session ends without exposing wire
// payloads, credentials, or implementation diagnostics.
type EndReason string

const (
	EndReasonPeerDisconnected EndReason = "peer_disconnected"
	EndReasonLocalDisconnect  EndReason = "local_disconnect"
	EndReasonPolicyRevoked    EndReason = "policy_revoked"
	EndReasonTransportError   EndReason = "transport_error"
)

var (
	// ErrInvalidDescriptor indicates an adapter declaration that cannot be
	// reviewed against a specific BetterDesk specification revision.
	ErrInvalidDescriptor = errors.New("interoperability: invalid adapter descriptor")
	// ErrInvalidAdmission indicates an incomplete or ambiguous inbound request.
	ErrInvalidAdmission = errors.New("interoperability: invalid inbound admission")
)

// AuditedSurface identifies a pre-existing compatibility dependency that is
// intentionally outside the independently-owned adapter boundary.
type AuditedSurface struct {
	Path   string
	Role   string
	Status string
}

const temporaryAuditedStatus = "temporary_audited"

// TemporaryAuditedSurfaces returns a fresh inventory of the current legacy
// wire path. Inclusion is an audit marker, not provenance approval or a reason
// for a future adapter to import these packages.
func TemporaryAuditedSurfaces() []AuditedSurface {
	return []AuditedSurface{
		{
			Path:   "betterdesk-support-agent/signalhost",
			Role:   "legacy desktop-client relay host",
			Status: temporaryAuditedStatus,
		},
		{
			Path:   "betterdesk-server/codec",
			Role:   "legacy wire framing dependency",
			Status: temporaryAuditedStatus,
		},
		{
			Path:   "betterdesk-server/proto",
			Role:   "legacy generated message dependency",
			Status: temporaryAuditedStatus,
		},
	}
}

func knownFeature(feature Feature) bool {
	switch feature {
	case FeatureDesktop,
		FeatureInput,
		FeatureAudio,
		FeatureClipboard,
		FeatureFiles,
		FeatureTerminal,
		FeatureMonitor,
		FeatureRestart:
		return true
	default:
		return false
	}
}
