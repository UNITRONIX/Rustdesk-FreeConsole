package sessioncore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Core is a concurrency-safe, single-use passive-session state machine.
// Create a new Core for each enrollment and session attempt.
type Core struct {
	mu sync.RWMutex

	audience            string
	deviceID            string
	allowedCapabilities []Capability
	verifier            GrantVerifier
	clock               func() time.Time
	eventSink           func(Event)

	state        State
	operatorID   string
	sessionID    string
	capabilities []Capability
	events       []Event
}

// New creates a Core in the registered state.
func New(cfg Config) (*Core, error) {
	if strings.TrimSpace(cfg.Audience) == "" || strings.TrimSpace(cfg.DeviceID) == "" || cfg.Verifier == nil {
		return nil, ErrInvalidConfiguration
	}

	allowed, err := validatePassiveCapabilities(cfg.AllowedCapabilities)
	if err != nil {
		return nil, fmt.Errorf("%w: allowed capabilities", ErrInvalidConfiguration)
	}

	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}

	c := &Core{
		audience:            cfg.Audience,
		deviceID:            cfg.DeviceID,
		allowedCapabilities: allowed,
		verifier:            cfg.Verifier,
		clock:               clock,
		eventSink:           cfg.EventSink,
		state:               StateRegistered,
	}

	c.mu.Lock()
	event := c.stateEventLocked(EventRegistered, "", StateRegistered, "")
	c.mu.Unlock()
	c.emit(event)

	return c, nil
}

// State returns the current lifecycle state.
func (c *Core) State() State {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

// Snapshot returns a copy of the current state without grant presentation data.
func (c *Core) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshotLocked()
}

// Events returns copies of all non-secret audit events in chronological order.
func (c *Core) Events() []Event {
	c.mu.RLock()
	defer c.mu.RUnlock()

	events := make([]Event, len(c.events))
	for i, event := range c.events {
		events[i] = cloneEvent(event)
	}
	return events
}

// BeginEnrollment marks this registered device as awaiting server approval.
func (c *Core) BeginEnrollment() error {
	return c.transition(StateRegistered, StatePending, EventEnrollmentPending)
}

// ApproveEnrollment records server-side enrollment approval.
func (c *Core) ApproveEnrollment() error {
	return c.transition(StatePending, StateApproved, EventEnrollmentApproved)
}

// Authorize verifies a server grant and, on success, records the effective
// passive capabilities. The opaque grant presentation is never retained.
func (c *Core) Authorize(ctx context.Context, request AdmissionRequest) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	request.RequestedCapabilities = cloneCapabilities(request.RequestedCapabilities)

	if strings.TrimSpace(request.OperatorID) == "" {
		return c.rejectAuthorization("invalid_operator", ErrGrantOperator)
	}
	if strings.TrimSpace(request.SessionID) == "" || strings.TrimSpace(request.Transport) == "" {
		return c.rejectAuthorization("invalid_session_binding", ErrGrantVerification)
	}
	if _, err := validatePassiveCapabilities(request.RequestedCapabilities); err != nil {
		return c.rejectAuthorization(authorizationReason(err), err)
	}

	c.mu.RLock()
	state := c.state
	verifier := c.verifier
	c.mu.RUnlock()
	if state != StateApproved {
		return c.rejectAuthorization("invalid_transition", invalidTransition(state, StateAuthorized))
	}

	grant, err := verifier.VerifySessionGrant(ctx, request.GrantPresentation)
	if err != nil {
		// Do not preserve or expose verifier errors: adapters may include
		// presentation details in their diagnostics.
		return c.rejectAuthorization("grant_verification_failed", ErrGrantVerification)
	}

	return c.completeAuthorization(request, grant)
}

// RequestConsent moves an authorized session to the local-consent phase.
func (c *Core) RequestConsent() error {
	return c.transition(StateAuthorized, StateConsent, EventConsentRequested)
}

// GrantConsent activates a session after affirmative local consent.
func (c *Core) GrantConsent() error {
	return c.transition(StateConsent, StateActive, EventConsentGranted)
}

// DenyConsent terminates a session only while it awaits local consent. It
// reports false when consent was not pending or the session was already ended.
func (c *Core) DenyConsent() bool {
	return c.terminate(EventConsentDenied, "consent_denied", StateConsent)
}

// Disconnect terminates any non-terminal session because the local user chose
// to disconnect. It is idempotent.
func (c *Core) Disconnect() bool {
	return c.terminate(EventLocalDisconnected, "local_disconnect", "")
}

// Cancel terminates any non-terminal session because local cancellation was
// requested. It is idempotent.
func (c *Core) Cancel() bool {
	return c.terminate(EventLocalCancellation, "local_cancellation", "")
}

// BindCancellation terminates the session when ctx is canceled. The returned
// function stops watching ctx and is safe to call more than once.
func (c *Core) BindCancellation(ctx context.Context) func() {
	if ctx == nil {
		return func() {}
	}

	done := make(chan struct{})
	var once sync.Once
	detach := func() {
		once.Do(func() {
			close(done)
		})
	}

	if ctx.Err() != nil {
		c.Cancel()
		return detach
	}

	go func() {
		select {
		case <-ctx.Done():
			c.Cancel()
		case <-done:
		}
	}()

	return detach
}

func (c *Core) completeAuthorization(request AdmissionRequest, grant SessionGrant) (Snapshot, error) {
	c.mu.Lock()
	if c.state != StateApproved {
		event := c.stateEventLocked(EventAuthorizationDenied, c.state, c.state, "invalid_transition")
		snapshot := c.snapshotLocked()
		c.mu.Unlock()
		c.emit(event)
		return snapshot, invalidTransition(snapshot.State, StateAuthorized)
	}

	effective, err := c.validateGrantLocked(request, grant)
	if err != nil {
		event := c.stateEventLocked(EventAuthorizationDenied, c.state, c.state, authorizationReason(err))
		snapshot := c.snapshotLocked()
		c.mu.Unlock()
		c.emit(event)
		return snapshot, err
	}

	from := c.state
	c.state = StateAuthorized
	c.operatorID = request.OperatorID
	c.sessionID = request.SessionID
	c.capabilities = effective
	event := c.stateEventLocked(EventAuthorized, from, StateAuthorized, "")
	snapshot := c.snapshotLocked()
	c.mu.Unlock()
	c.emit(event)
	return snapshot, nil
}

func (c *Core) validateGrantLocked(request AdmissionRequest, grant SessionGrant) ([]Capability, error) {
	if grant.Audience != c.audience {
		return nil, ErrGrantAudience
	}
	if grant.DeviceID != c.deviceID {
		return nil, ErrGrantDevice
	}
	if grant.OperatorID != request.OperatorID {
		return nil, ErrGrantOperator
	}
	if grant.SessionID != request.SessionID {
		return nil, ErrGrantVerification
	}
	if grant.Transport != request.Transport {
		return nil, ErrGrantVerification
	}
	if !grant.ExpiresAt.After(c.clock()) {
		return nil, ErrGrantExpired
	}
	if grant.Initiator != InitiatorOperator {
		return nil, ErrPassiveOnly
	}

	granted, err := validatePassiveCapabilities(grant.Capabilities)
	if err != nil {
		return nil, err
	}
	effective := intersectCapabilities(c.allowedCapabilities, granted, request.RequestedCapabilities)
	if len(effective) == 0 {
		return nil, ErrGrantCapabilities
	}
	return effective, nil
}

func (c *Core) rejectAuthorization(reason string, err error) (Snapshot, error) {
	c.mu.Lock()
	event := c.stateEventLocked(EventAuthorizationDenied, c.state, c.state, reason)
	snapshot := c.snapshotLocked()
	c.mu.Unlock()
	c.emit(event)
	return snapshot, err
}

func (c *Core) transition(expected, next State, kind EventKind) error {
	c.mu.Lock()
	if c.state != expected {
		event := c.stateEventLocked(EventTransitionDenied, c.state, c.state, "invalid_transition")
		from := c.state
		c.mu.Unlock()
		c.emit(event)
		return invalidTransition(from, next)
	}

	from := c.state
	c.state = next
	event := c.stateEventLocked(kind, from, next, "")
	c.mu.Unlock()
	c.emit(event)
	return nil
}

func (c *Core) terminate(kind EventKind, reason string, required State) bool {
	c.mu.Lock()
	if c.state == StateTerminated {
		c.mu.Unlock()
		return false
	}
	if required != "" && c.state != required {
		event := c.stateEventLocked(EventTransitionDenied, c.state, c.state, "invalid_transition")
		c.mu.Unlock()
		c.emit(event)
		return false
	}

	from := c.state
	c.state = StateTerminated
	event := c.stateEventLocked(kind, from, StateTerminated, reason)
	c.mu.Unlock()
	c.emit(event)
	return true
}

func (c *Core) snapshotLocked() Snapshot {
	return Snapshot{
		State:        c.state,
		DeviceID:     c.deviceID,
		OperatorID:   c.operatorID,
		SessionID:    c.sessionID,
		Capabilities: cloneCapabilities(c.capabilities),
	}
}

func (c *Core) stateEventLocked(kind EventKind, from, to State, reason string) Event {
	return c.recordLocked(Event{
		Kind:         kind,
		From:         from,
		To:           to,
		DeviceID:     c.deviceID,
		OperatorID:   c.operatorID,
		SessionID:    c.sessionID,
		Capabilities: c.capabilities,
		Reason:       reason,
	})
}

func (c *Core) recordLocked(event Event) Event {
	event.At = c.clock().UTC()
	event.Capabilities = cloneCapabilities(event.Capabilities)
	c.events = append(c.events, event)
	return cloneEvent(event)
}

func (c *Core) emit(event Event) {
	if c.eventSink != nil {
		c.eventSink(cloneEvent(event))
	}
}

func validatePassiveCapabilities(capabilities []Capability) ([]Capability, error) {
	if len(capabilities) == 0 {
		return nil, ErrGrantCapabilities
	}

	seen := make(map[Capability]struct{}, len(capabilities))
	result := make([]Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if !isPassiveCapability(capability) {
			return nil, ErrPassiveOnly
		}
		if _, duplicate := seen[capability]; duplicate {
			return nil, ErrGrantCapabilities
		}
		seen[capability] = struct{}{}
		result = append(result, capability)
	}
	return result, nil
}

func isPassiveCapability(capability Capability) bool {
	switch capability {
	case CapabilityScreenView,
		CapabilityInput,
		CapabilitySystemAudio,
		CapabilityClipboard,
		CapabilityFiles,
		CapabilityTerminal,
		CapabilityChat,
		CapabilityMultiMonitor,
		CapabilityPrivacyMode,
		CapabilityBlockInput,
		CapabilityRestart,
		CapabilityRecording:
		return true
	default:
		return false
	}
}

func intersectCapabilities(allowed, granted, requested []Capability) []Capability {
	grantedSet := make(map[Capability]struct{}, len(granted))
	for _, capability := range granted {
		grantedSet[capability] = struct{}{}
	}
	requestedSet := make(map[Capability]struct{}, len(requested))
	for _, capability := range requested {
		requestedSet[capability] = struct{}{}
	}

	effective := make([]Capability, 0, len(allowed))
	for _, capability := range allowed {
		if _, grantAllows := grantedSet[capability]; !grantAllows {
			continue
		}
		if _, requestedByOperator := requestedSet[capability]; !requestedByOperator {
			continue
		}
		effective = append(effective, capability)
	}
	return effective
}

func cloneCapabilities(capabilities []Capability) []Capability {
	return append([]Capability(nil), capabilities...)
}

func cloneEvent(event Event) Event {
	event.Capabilities = cloneCapabilities(event.Capabilities)
	return event
}

func invalidTransition(from, to State) error {
	return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, from, to)
}

func authorizationReason(err error) string {
	switch {
	case errors.Is(err, ErrGrantVerification):
		return "grant_verification_failed"
	case errors.Is(err, ErrGrantAudience):
		return "grant_audience_mismatch"
	case errors.Is(err, ErrGrantDevice):
		return "grant_device_mismatch"
	case errors.Is(err, ErrGrantOperator):
		return "grant_operator_mismatch"
	case errors.Is(err, ErrGrantExpired):
		return "grant_expired"
	case errors.Is(err, ErrPassiveOnly):
		return "passive_policy_violation"
	case errors.Is(err, ErrGrantCapabilities):
		return "grant_capability_mismatch"
	default:
		return "authorization_denied"
	}
}
