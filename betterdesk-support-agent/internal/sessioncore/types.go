package sessioncore

import (
	"context"
	"errors"
	"time"
)

// State is the current phase of a passive BetterDesk support session.
type State string

const (
	// StateRegistered is the initial state for a locally known device.
	StateRegistered State = "registered"
	// StatePending means the device is awaiting server-side enrollment approval.
	StatePending State = "pending"
	// StateApproved means device enrollment has been approved.
	StateApproved State = "approved"
	// StateAuthorized means a verified server grant authorized an operator.
	StateAuthorized State = "authorized"
	// StateConsent means the locally present user must decide whether to continue.
	StateConsent State = "consent"
	// StateActive means the passive session may be connected to its transport.
	StateActive State = "active"
	// StateTerminated is final for a Core instance.
	StateTerminated State = "terminated"
)

// Capability describes an operation allowed in a passive support session.
// "Passive" constrains who may initiate the session; it does not turn an
// approved remote-support session into a view-only stream.
type Capability string

const (
	// CapabilityScreenView allows the device display to be sent to the operator.
	CapabilityScreenView Capability = "screen_view"
	// CapabilityInput allows the approved operator to inject desktop input.
	CapabilityInput Capability = "input"
	// CapabilitySystemAudio allows device audio to be sent to the operator.
	CapabilitySystemAudio Capability = "system_audio"
	// CapabilityClipboard allows clipboard synchronization for the session.
	CapabilityClipboard Capability = "clipboard"
	// CapabilityFiles allows file transfer subject to the local file policy.
	CapabilityFiles Capability = "files"
	// CapabilityTerminal allows terminal sessions subject to local consent.
	CapabilityTerminal Capability = "terminal"
	// CapabilityChat allows session chat.
	CapabilityChat Capability = "chat"
	// CapabilityMultiMonitor allows display selection.
	CapabilityMultiMonitor Capability = "multi_monitor"
	// CapabilityPrivacyMode enables only a platform-supported privacy mode.
	CapabilityPrivacyMode Capability = "privacy_mode"
	// CapabilityBlockInput enables only a platform-supported local-input block.
	CapabilityBlockInput Capability = "block_input"
	// CapabilityRestart permits a policy-controlled restart request.
	CapabilityRestart Capability = "restart"
	// CapabilityRecording permits policy-controlled recording.
	CapabilityRecording Capability = "recording"
)

// SessionInitiator identifies the party permitted to create a session. It
// says nothing about approved input or response traffic inside that session.
type SessionInitiator string

const (
	// InitiatorOperator means an operator/controller connected to the passive
	// Support Agent. Support Agent itself may never be the initiator.
	InitiatorOperator SessionInitiator = "operator"
)

// SessionGrant is the verified, non-secret claim set from a BetterDesk server.
// Grant presentation material is intentionally not retained in this type.
type SessionGrant struct {
	Audience     string
	DeviceID     string
	OperatorID   string
	SessionID    string
	Transport    string
	Capabilities []Capability
	ExpiresAt    time.Time
	Initiator    SessionInitiator
}

// AdmissionRequest is an operator's request to begin a passive session.
// GrantPresentation is opaque to Core, passed only to GrantVerifier, and never
// stored or included in an Event.
type AdmissionRequest struct {
	OperatorID            string
	SessionID             string
	Transport             string
	RequestedCapabilities []Capability
	GrantPresentation     string
}

// GrantVerifier validates a server-issued grant and returns its verified claims.
// Core then binds those claims to its configured audience and device, the
// requesting operator, passive capabilities, and the current time.
type GrantVerifier interface {
	VerifySessionGrant(context.Context, string) (SessionGrant, error)
}

// GrantVerifierFunc adapts a function into a GrantVerifier.
type GrantVerifierFunc func(context.Context, string) (SessionGrant, error)

// VerifySessionGrant implements GrantVerifier.
func (f GrantVerifierFunc) VerifySessionGrant(ctx context.Context, presentation string) (SessionGrant, error) {
	if f == nil {
		return SessionGrant{}, ErrGrantVerification
	}
	return f(ctx, presentation)
}

// EventKind identifies a non-secret audit event emitted by Core.
type EventKind string

const (
	EventRegistered          EventKind = "registered"
	EventEnrollmentPending   EventKind = "enrollment_pending"
	EventEnrollmentApproved  EventKind = "enrollment_approved"
	EventAuthorized          EventKind = "authorized"
	EventAuthorizationDenied EventKind = "authorization_denied"
	EventConsentRequested    EventKind = "consent_requested"
	EventConsentGranted      EventKind = "consent_granted"
	EventConsentDenied       EventKind = "consent_denied"
	EventLocalDisconnected   EventKind = "local_disconnected"
	EventLocalCancellation   EventKind = "local_cancellation"
	EventTransitionDenied    EventKind = "transition_denied"
)

// Event is an auditable state-machine record. It deliberately contains no
// grant presentation, credential, token, or verifier error payload.
type Event struct {
	At           time.Time
	Kind         EventKind
	From         State
	To           State
	DeviceID     string
	OperatorID   string
	SessionID    string
	Capabilities []Capability
	Reason       string
}

// Snapshot is a concurrency-safe copy of the current public session state.
type Snapshot struct {
	State        State
	DeviceID     string
	OperatorID   string
	SessionID    string
	Capabilities []Capability
}

// Config binds a Core to one BetterDesk device and audience.
type Config struct {
	Audience            string
	DeviceID            string
	AllowedCapabilities []Capability
	Verifier            GrantVerifier

	// Clock is optional and defaults to time.Now.
	Clock func() time.Time
	// EventSink is optional. It receives copies of events after Core records them.
	EventSink func(Event)
}

var (
	// ErrInvalidConfiguration indicates a Core configuration that cannot enforce
	// passive-session policy.
	ErrInvalidConfiguration = errors.New("sessioncore: invalid configuration")
	// ErrInvalidTransition indicates an action that is not valid for the current state.
	ErrInvalidTransition = errors.New("sessioncore: invalid state transition")
	// ErrGrantVerification indicates that the injected verifier rejected a grant.
	ErrGrantVerification = errors.New("sessioncore: grant verification failed")
	// ErrGrantAudience indicates a grant for another BetterDesk audience.
	ErrGrantAudience = errors.New("sessioncore: grant audience mismatch")
	// ErrGrantDevice indicates a grant for another device.
	ErrGrantDevice = errors.New("sessioncore: grant device mismatch")
	// ErrGrantOperator indicates a grant that is not bound to the requesting operator.
	ErrGrantOperator = errors.New("sessioncore: grant operator mismatch")
	// ErrGrantExpired indicates an expired or otherwise unusable grant.
	ErrGrantExpired = errors.New("sessioncore: grant expired")
	// ErrGrantCapabilities indicates a grant or request with no permitted overlap.
	ErrGrantCapabilities = errors.New("sessioncore: grant capability mismatch")
	// ErrPassiveOnly indicates a direction or capability that violates passive mode.
	ErrPassiveOnly = errors.New("sessioncore: passive sessions are one-way only")
)
