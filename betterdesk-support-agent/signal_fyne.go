//go:build fyneui

package main

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
