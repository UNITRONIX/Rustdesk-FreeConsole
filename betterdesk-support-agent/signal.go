package main

import (
	"encoding/hex"
	"time"

	"github.com/unitronix/betterdesk-support-agent/internal/totp"
	"github.com/unitronix/betterdesk-support-agent/signalhost"
)

type signalHostCallbacks struct {
	consent   func(operator string) bool
	onSession func(start bool, operator string)
	audit     func(policy hostCapabilityPolicy)
}

// newSignalHost builds an outbound-only RustDesk-compatible relay host when
// the current local access policy permits it. The returned reason is intended
// for headless startup logs, where there is no UI to explain why the host is
// unavailable.
func newSignalHost(brand Branding, st *AppState, headless bool, callbacks signalHostCallbacks) (*signalhost.Host, string) {
	if !brand.HasConnection() {
		return nil, "no server is configured"
	}
	policy := accessPolicyFor(brand, st)
	if callbacks.audit != nil {
		callbacks.audit(hostCapabilityPolicyFor(brand))
	}
	if !policy.allowsSignalHost(headless) {
		return nil, policy.signalHostDisabledReason(headless)
	}

	deviceID, _, _, _ := st.Snapshot()
	uuidBytes, _ := hex.DecodeString(st.GetMachineUUID())
	return signalhost.New(signalhost.Config{
		SignalAddr: signalAddress(brand),
		RelayAddr:  relayAddress(brand),
		DeviceID:   deviceID,
		UUID:       uuidBytes,
		DataDir:    stateDir(),
		Password: func() string {
			_, _, pw, _ := st.Snapshot()
			return pw
		},
		Unattended: func() bool {
			return accessPolicyFor(brand, st).allowsUnattended()
		},
		TOTPEnabled: func() bool {
			enabled, _ := st.TOTPSnapshot()
			return enabled
		},
		TOTPVerify: func(code string) bool {
			_, secret := st.TOTPSnapshot()
			return secret != "" && totp.Validate(secret, code, time.Now())
		},
		AccessAllowed: func() bool {
			return accessPolicyFor(brand, st).allowsSignalHost(headless)
		},
		DesktopEnabled: policy.capabilities.Desktop,
		AudioEnabled:   policy.capabilities.Audio,
		RestartEnabled: policy.capabilities.Restart,
		Consent:        callbacks.consent,
		OnSession:      callbacks.onSession,
	}), ""
}

func (u *ui) startSignalHost() {
	u.signalHostMu.Lock()
	defer u.signalHostMu.Unlock()
	if u.signalHost != nil {
		return
	}
	host, _ := newSignalHost(u.brand, u.state, false, signalHostCallbacks{
		consent: func(operator string) bool {
			return u.handleConsent("signal", operator)
		},
		audit: func(policy hostCapabilityPolicy) {
			auditHostCapabilityPolicy(hostCapabilityAuditTransportSignal, policy)
		},
		onSession: func(start bool, operator string) {
			if start {
				_, mode, _, _ := u.state.Snapshot()
				u.handleSessionStart("signal", operator, mode)
			} else {
				u.handleSessionEnd("signal")
			}
		},
	})
	if host == nil || !host.Start() {
		return
	}
	u.signalHost = host
	appLogInfo("signal_host", "signal/relay host started", map[string]any{
		"signal": signalAddress(u.brand),
		"relay":  relayAddress(u.brand),
	})
}

func (u *ui) stopSignalHost() {
	u.signalHostMu.Lock()
	host := u.signalHost
	u.signalHost = nil
	u.signalHostMu.Unlock()
	if host != nil {
		host.Stop()
	}
}

func (u *ui) disconnectSignalSessions() {
	u.signalHostMu.Lock()
	host := u.signalHost
	u.signalHostMu.Unlock()
	if host != nil {
		host.DisconnectSessions()
	}
}

func signalAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21116"
}

func relayAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21117"
}
