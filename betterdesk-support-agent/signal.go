package main

import (
	"encoding/hex"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-support-agent/signalhost"
)

func (u *ui) startSignalHost() {
	if u.signalHost != nil || !u.brand.HasConnection() {
		return
	}
	uuidBytes, _ := hex.DecodeString(u.state.GetMachineUUID())
	host := signalhost.New(signalhost.Config{
		SignalAddr: signalAddress(u.brand),
		RelayAddr:  relayAddress(u.brand),
		DeviceID:   u.state.DeviceID,
		UUID:       uuidBytes,
		DataDir:    stateDir(),
		Password: func() string {
			_, _, pw, _ := u.state.Snapshot()
			return pw
		},
		Unattended: func() bool {
			_, mode, _, _ := u.state.Snapshot()
			return mode == AccessUnattended
		},
		TOTPEnabled: func() bool {
			enabled, _ := u.state.TOTPSnapshot()
			return enabled
		},
		TOTPVerify: func(code string) bool {
			_, secret := u.state.TOTPSnapshot()
			return secret != "" && auth.ValidateTOTP(secret, code)
		},
		Consent: func(operator string) bool {
			return u.handleConsent("signal", operator)
		},
		OnSession: func(start bool, operator string) {
			if start {
				u.handleSessionStart("signal", operator, "supervised")
			} else {
				u.handleSessionEnd("signal")
			}
		},
	})
	u.signalHost = host
	host.Start()
	appLogInfo("signal_host", "signal/relay host started", map[string]any{
		"signal": signalAddress(u.brand),
		"relay":  relayAddress(u.brand),
	})
}

func signalAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21116"
}

func relayAddress(b Branding) string {
	return hostFromAddr(b.ServerAddress) + ":21117"
}
