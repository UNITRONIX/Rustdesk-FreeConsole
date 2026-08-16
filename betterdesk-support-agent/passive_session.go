package main

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/unitronix/betterdesk-support-agent/internal/sessioncore"
)

const supportSessionGrantAudience = "betterdesk-support-agent"

// passiveSessionAuthorizer bridges the generic embedded CDAP engine to the
// independently-owned Support Agent session core. It retains no grant token:
// grants are verified once, scoped to one session, and represented afterward
// only by non-secret audit events.
type passiveSessionAuthorizer struct {
	mu                  sync.Mutex
	deviceID            string
	allowedCapabilities []sessioncore.Capability
	verifier            sessioncore.GrantVerifier
	sessions            map[string]*sessioncore.Core
}

func newPassiveSessionAuthorizer(brand Branding, st *AppState) (*passiveSessionAuthorizer, error) {
	if st == nil {
		return nil, fmt.Errorf("missing application state")
	}
	st.mu.Lock()
	deviceID := strings.TrimSpace(st.DeviceID)
	st.mu.Unlock()
	publicKey := strings.TrimSpace(brand.ServerKey)
	if publicKey == "" && brand.Server != nil {
		publicKey = strings.TrimSpace(brand.Server.PublicKey)
	}
	verifier, err := sessioncore.NewEd25519GrantVerifier(publicKey)
	if err != nil {
		return nil, fmt.Errorf("configure session-grant verifier: %w", err)
	}
	capabilities := policySessionCapabilities(accessPolicyFor(brand, st))
	if len(capabilities) == 0 {
		return nil, fmt.Errorf("desktop capability is disabled")
	}
	return &passiveSessionAuthorizer{
		deviceID:            deviceID,
		allowedCapabilities: capabilities,
		verifier:            verifier,
		sessions:            make(map[string]*sessioncore.Core),
	}, nil
}

func policySessionCapabilities(policy incomingAccessPolicy) []sessioncore.Capability {
	capabilities := make([]sessioncore.Capability, 0, 8)
	if policy.capabilities.Desktop {
		capabilities = append(capabilities, sessioncore.CapabilityScreenView, sessioncore.CapabilityInput)
	}
	if policy.capabilities.Audio {
		capabilities = append(capabilities, sessioncore.CapabilitySystemAudio)
	}
	if policy.capabilities.Clipboard {
		capabilities = append(capabilities, sessioncore.CapabilityClipboard)
	}
	if policy.capabilities.Files {
		capabilities = append(capabilities, sessioncore.CapabilityFiles)
	}
	if policy.capabilities.Terminal {
		capabilities = append(capabilities, sessioncore.CapabilityTerminal)
	}
	if policy.capabilities.Restart {
		capabilities = append(capabilities, sessioncore.CapabilityRestart)
	}
	return capabilities
}

func (a *passiveSessionAuthorizer) Authorize(
	sessionID, operatorID, transport string,
	requested []string,
	grant string,
	requireConsent bool,
) error {
	if a == nil {
		return fmt.Errorf("passive session authorizer is unavailable")
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return fmt.Errorf("missing session ID")
	}
	requestedCapabilities := make([]sessioncore.Capability, 0, len(requested))
	for _, capability := range requested {
		requestedCapabilities = append(requestedCapabilities, sessioncore.Capability(strings.TrimSpace(capability)))
	}

	core, err := sessioncore.New(sessioncore.Config{
		Audience:            supportSessionGrantAudience,
		DeviceID:            a.deviceID,
		AllowedCapabilities: a.allowedCapabilities,
		Verifier:            a.verifier,
		EventSink:           logPassiveSessionEvent,
	})
	if err != nil {
		return err
	}
	if err := core.BeginEnrollment(); err != nil {
		return err
	}
	if err := core.ApproveEnrollment(); err != nil {
		return err
	}
	if _, err := core.Authorize(context.Background(), sessioncore.AdmissionRequest{
		OperatorID:            operatorID,
		SessionID:             sessionID,
		Transport:             transport,
		RequestedCapabilities: requestedCapabilities,
		GrantPresentation:     grant,
	}); err != nil {
		return err
	}
	if err := core.RequestConsent(); err != nil {
		return err
	}
	if !requireConsent {
		if err := core.GrantConsent(); err != nil {
			return err
		}
	}

	a.mu.Lock()
	if existing := a.sessions[sessionID]; existing != nil {
		existing.Disconnect()
	}
	a.sessions[sessionID] = core
	a.mu.Unlock()
	return nil
}

func (a *passiveSessionAuthorizer) ResolveConsent(sessionID string, granted bool) {
	core := a.lookup(sessionID)
	if core == nil {
		return
	}
	if granted {
		_ = core.GrantConsent()
		return
	}
	core.DenyConsent()
	a.remove(sessionID, core)
}

func (a *passiveSessionAuthorizer) End(sessionID string) {
	core := a.lookup(sessionID)
	if core == nil {
		return
	}
	core.Disconnect()
	a.remove(sessionID, core)
}

func (a *passiveSessionAuthorizer) lookup(sessionID string) *sessioncore.Core {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[sessionID]
}

func (a *passiveSessionAuthorizer) remove(sessionID string, expected *sessioncore.Core) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessions[sessionID] == expected {
		delete(a.sessions, sessionID)
	}
}

func logPassiveSessionEvent(event sessioncore.Event) {
	appLogInfo("passive_session", string(event.Kind), map[string]any{
		"session_id":  event.SessionID,
		"device_id":   event.DeviceID,
		"operator_id": event.OperatorID,
		"from":        string(event.From),
		"to":          string(event.To),
		"reason":      event.Reason,
	})
}
