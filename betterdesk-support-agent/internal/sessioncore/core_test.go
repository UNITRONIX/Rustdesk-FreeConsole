package sessioncore

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

var fixedNow = time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)

func TestLifecycleTransitionsCapabilityIntersectionAndAudit(t *testing.T) {
	const presentation = "opaque-grant-that-must-not-be-audited"
	var verifierPresentation string
	core := newCore(t, GrantVerifierFunc(func(_ context.Context, got string) (SessionGrant, error) {
		verifierPresentation = got
		return validGrant(), nil
	}))

	if got := core.State(); got != StateRegistered {
		t.Fatalf("initial state = %q, want %q", got, StateRegistered)
	}
	if err := core.BeginEnrollment(); err != nil {
		t.Fatalf("begin enrollment: %v", err)
	}
	if err := core.ApproveEnrollment(); err != nil {
		t.Fatalf("approve enrollment: %v", err)
	}

	snapshot, err := core.Authorize(context.Background(), AdmissionRequest{
		OperatorID:            "operator-42",
		SessionID:             "session-1",
		Transport:             "relay",
		RequestedCapabilities: []Capability{CapabilityScreenView},
		GrantPresentation:     presentation,
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if verifierPresentation != presentation {
		t.Fatalf("verifier received %q, want presentation", verifierPresentation)
	}
	if snapshot.State != StateAuthorized {
		t.Fatalf("authorized state = %q, want %q", snapshot.State, StateAuthorized)
	}
	if want := []Capability{CapabilityScreenView}; !reflect.DeepEqual(snapshot.Capabilities, want) {
		t.Fatalf("effective capabilities = %v, want %v", snapshot.Capabilities, want)
	}

	if err := core.RequestConsent(); err != nil {
		t.Fatalf("request consent: %v", err)
	}
	if err := core.GrantConsent(); err != nil {
		t.Fatalf("grant consent: %v", err)
	}
	if !core.Disconnect() {
		t.Fatal("first disconnect should terminate the session")
	}
	if core.Disconnect() {
		t.Fatal("second disconnect should be idempotent")
	}
	if got := core.State(); got != StateTerminated {
		t.Fatalf("final state = %q, want %q", got, StateTerminated)
	}

	events := core.Events()
	if len(events) != 7 {
		t.Fatalf("events = %d, want 7", len(events))
	}
	last := events[len(events)-1]
	if last.Kind != EventLocalDisconnected || last.From != StateActive || last.To != StateTerminated {
		t.Fatalf("last event = %#v, want active local disconnect", last)
	}

	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}
	if strings.Contains(string(encoded), presentation) {
		t.Fatal("audit events contain grant presentation")
	}
}

func TestAuthorizeRejectsInvalidGrants(t *testing.T) {
	tests := []struct {
		name   string
		grant  SessionGrant
		err    error
		reason string
	}{
		{
			name: "wrong audience",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.Audience = "other-audience"
				return grant
			}(),
			err:    ErrGrantAudience,
			reason: "grant_audience_mismatch",
		},
		{
			name: "wrong device",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.DeviceID = "other-device"
				return grant
			}(),
			err:    ErrGrantDevice,
			reason: "grant_device_mismatch",
		},
		{
			name: "wrong operator",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.OperatorID = "other-operator"
				return grant
			}(),
			err:    ErrGrantOperator,
			reason: "grant_operator_mismatch",
		},
		{
			name: "expired",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.ExpiresAt = fixedNow
				return grant
			}(),
			err:    ErrGrantExpired,
			reason: "grant_expired",
		},
		{
			name: "non-operator initiator",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.Initiator = SessionInitiator("support_agent")
				return grant
			}(),
			err:    ErrPassiveOnly,
			reason: "passive_policy_violation",
		},
		{
			name: "unknown capability",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.Capabilities = []Capability{"session_initiate"}
				return grant
			}(),
			err:    ErrPassiveOnly,
			reason: "passive_policy_violation",
		},
		{
			name: "no capability intersection",
			grant: func() SessionGrant {
				grant := validGrant()
				grant.Capabilities = []Capability{CapabilitySystemAudio}
				return grant
			}(),
			err:    ErrGrantCapabilities,
			reason: "grant_capability_mismatch",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			core := approvedCore(t, GrantVerifierFunc(func(context.Context, string) (SessionGrant, error) {
				return test.grant, nil
			}))

			_, err := core.Authorize(context.Background(), AdmissionRequest{
				OperatorID:            "operator-42",
				SessionID:             "session-1",
				Transport:             "relay",
				RequestedCapabilities: []Capability{CapabilityScreenView},
				GrantPresentation:     "opaque-presentation",
			})
			if !errors.Is(err, test.err) {
				t.Fatalf("authorize error = %v, want %v", err, test.err)
			}
			if got := core.State(); got != StateApproved {
				t.Fatalf("state after failed authorization = %q, want %q", got, StateApproved)
			}

			events := core.Events()
			last := events[len(events)-1]
			if last.Kind != EventAuthorizationDenied || last.Reason != test.reason {
				t.Fatalf("last event = %#v, want authorization denial %q", last, test.reason)
			}
		})
	}
}

func TestInboundGrantCanAuthorizeRemoteControlCapabilities(t *testing.T) {
	grant := validGrant()
	grant.Capabilities = []Capability{CapabilityScreenView, CapabilityInput, CapabilityFiles}
	core, err := New(Config{
		Audience:            "betterdesk-support",
		DeviceID:            "BD-DEVICE-1",
		AllowedCapabilities: []Capability{CapabilityScreenView, CapabilityInput, CapabilityFiles},
		Verifier: GrantVerifierFunc(func(context.Context, string) (SessionGrant, error) {
			return grant, nil
		}),
		Clock: func() time.Time { return fixedNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := core.BeginEnrollment(); err != nil {
		t.Fatal(err)
	}
	if err := core.ApproveEnrollment(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := core.Authorize(context.Background(), AdmissionRequest{
		OperatorID:            "operator-42",
		SessionID:             "session-1",
		Transport:             "relay",
		RequestedCapabilities: []Capability{CapabilityScreenView, CapabilityInput, CapabilityFiles},
		GrantPresentation:     "opaque-presentation",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []Capability{CapabilityScreenView, CapabilityInput, CapabilityFiles}
	if !reflect.DeepEqual(snapshot.Capabilities, want) {
		t.Fatalf("effective capabilities = %v, want %v", snapshot.Capabilities, want)
	}
}

func TestEd25519GrantVerifierRejectsAlteredOrOutboundGrants(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewEd25519GrantVerifier(base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	verifier.now = func() time.Time { return fixedNow }

	claims := signedGrantClaims{
		Version:      1,
		Audience:     "betterdesk-support",
		DeviceID:     "BD-DEVICE-1",
		OperatorID:   "operator-42",
		SessionID:    "session-1",
		Transport:    "relay",
		Initiator:    "operator",
		Capabilities: []string{"screen_view", "input"},
		IssuedAt:     fixedNow.Unix(),
		ExpiresAt:    fixedNow.Add(time.Minute).Unix(),
	}
	token := signTestGrant(t, privateKey, claims)
	grant, err := verifier.VerifySessionGrant(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(grant.Capabilities, []Capability{CapabilityScreenView, CapabilityInput}) {
		t.Fatalf("decoded capabilities = %#v", grant.Capabilities)
	}

	claims.Initiator = "support_agent"
	if _, err := verifier.VerifySessionGrant(context.Background(), signTestGrant(t, privateKey, claims)); !errors.Is(err, ErrGrantVerification) {
		t.Fatalf("outbound initiator error = %v, want verification error", err)
	}

	parts := strings.Split(token, ".")
	replacement := byte('A')
	if parts[1][0] == replacement {
		replacement = 'B'
	}
	parts[1] = string(replacement) + parts[1][1:]
	tampered := strings.Join(parts, ".")
	if _, err := verifier.VerifySessionGrant(context.Background(), tampered); !errors.Is(err, ErrGrantVerification) {
		t.Fatalf("tampered grant error = %v, want verification error", err)
	}
}

func TestAuthorizeDoesNotExposeVerifierDetails(t *testing.T) {
	const secret = "grant-presentation-must-not-leak"
	core := approvedCore(t, GrantVerifierFunc(func(context.Context, string) (SessionGrant, error) {
		return SessionGrant{}, errors.New(secret)
	}))

	_, err := core.Authorize(context.Background(), AdmissionRequest{
		OperatorID:            "operator-42",
		SessionID:             "session-1",
		Transport:             "relay",
		RequestedCapabilities: []Capability{CapabilityScreenView},
		GrantPresentation:     secret,
	})
	if !errors.Is(err, ErrGrantVerification) {
		t.Fatalf("authorize error = %v, want %v", err, ErrGrantVerification)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("authorization error exposes verifier detail")
	}

	encoded, marshalErr := json.Marshal(core.Events())
	if marshalErr != nil {
		t.Fatalf("marshal events: %v", marshalErr)
	}
	if strings.Contains(string(encoded), secret) {
		t.Fatal("audit events expose verifier detail or presentation")
	}
}

func TestStateMachineRejectsSkippedTransitions(t *testing.T) {
	core := newCore(t, GrantVerifierFunc(func(context.Context, string) (SessionGrant, error) {
		return validGrant(), nil
	}))

	if err := core.ApproveEnrollment(); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("approve before pending error = %v, want %v", err, ErrInvalidTransition)
	}
	if _, err := core.Authorize(context.Background(), AdmissionRequest{
		OperatorID:            "operator-42",
		SessionID:             "session-1",
		Transport:             "relay",
		RequestedCapabilities: []Capability{CapabilityScreenView},
		GrantPresentation:     "opaque-presentation",
	}); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("authorize before approval error = %v, want %v", err, ErrInvalidTransition)
	}
}

func TestDisconnectIsConcurrencySafeAndIdempotent(t *testing.T) {
	core := activeCore(t)

	const callers = 32
	results := make(chan bool, callers)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- core.Disconnect()
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	terminated := 0
	for result := range results {
		if result {
			terminated++
		}
	}
	if terminated != 1 {
		t.Fatalf("successful disconnects = %d, want 1", terminated)
	}
	if got := core.State(); got != StateTerminated {
		t.Fatalf("state = %q, want %q", got, StateTerminated)
	}

	disconnectEvents := 0
	for _, event := range core.Events() {
		if event.Kind == EventLocalDisconnected {
			disconnectEvents++
		}
	}
	if disconnectEvents != 1 {
		t.Fatalf("disconnect events = %d, want 1", disconnectEvents)
	}
}

func TestBindCancellationTerminatesActiveSession(t *testing.T) {
	core := activeCore(t)
	ctx, cancel := context.WithCancel(context.Background())
	detach := core.BindCancellation(ctx)
	defer detach()

	cancel()
	deadline := time.Now().Add(time.Second)
	for core.State() != StateTerminated && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := core.State(); got != StateTerminated {
		t.Fatalf("state after cancellation = %q, want %q", got, StateTerminated)
	}

	events := core.Events()
	last := events[len(events)-1]
	if last.Kind != EventLocalCancellation || last.Reason != "local_cancellation" {
		t.Fatalf("last event = %#v, want local cancellation", last)
	}
}

func newCore(t *testing.T, verifier GrantVerifier) *Core {
	t.Helper()
	core, err := New(Config{
		Audience:            "betterdesk-support",
		DeviceID:            "BD-DEVICE-1",
		AllowedCapabilities: []Capability{CapabilityScreenView, CapabilitySystemAudio},
		Verifier:            verifier,
		Clock: func() time.Time {
			return fixedNow
		},
	})
	if err != nil {
		t.Fatalf("new core: %v", err)
	}
	return core
}

func approvedCore(t *testing.T, verifier GrantVerifier) *Core {
	t.Helper()
	core := newCore(t, verifier)
	if err := core.BeginEnrollment(); err != nil {
		t.Fatalf("begin enrollment: %v", err)
	}
	if err := core.ApproveEnrollment(); err != nil {
		t.Fatalf("approve enrollment: %v", err)
	}
	return core
}

func activeCore(t *testing.T) *Core {
	t.Helper()
	core := approvedCore(t, GrantVerifierFunc(func(context.Context, string) (SessionGrant, error) {
		return validGrant(), nil
	}))
	if _, err := core.Authorize(context.Background(), AdmissionRequest{
		OperatorID:            "operator-42",
		SessionID:             "session-1",
		Transport:             "relay",
		RequestedCapabilities: []Capability{CapabilityScreenView},
		GrantPresentation:     "opaque-presentation",
	}); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if err := core.RequestConsent(); err != nil {
		t.Fatalf("request consent: %v", err)
	}
	if err := core.GrantConsent(); err != nil {
		t.Fatalf("grant consent: %v", err)
	}
	return core
}

func validGrant() SessionGrant {
	return SessionGrant{
		Audience:     "betterdesk-support",
		DeviceID:     "BD-DEVICE-1",
		OperatorID:   "operator-42",
		SessionID:    "session-1",
		Transport:    "relay",
		Capabilities: []Capability{CapabilityScreenView, CapabilitySystemAudio},
		ExpiresAt:    fixedNow.Add(time.Minute),
		Initiator:    InitiatorOperator,
	}
}

func signTestGrant(t *testing.T, privateKey ed25519.PrivateKey, claims signedGrantClaims) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, payload)
	return strings.Join([]string{
		signedGrantVersion,
		base64.RawURLEncoding.EncodeToString(payload),
		base64.RawURLEncoding.EncodeToString(signature),
	}, ".")
}
