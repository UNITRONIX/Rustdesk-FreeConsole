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
// the current local access policy permits it.
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

func signalAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21116"
}

func relayAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21117"
}
