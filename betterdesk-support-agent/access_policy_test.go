package main

import "testing"

func boolRef(v bool) *bool {
	return &v
}

func TestHeadlessConsentRequiresApprovedUnattendedAccess(t *testing.T) {
	st := &AppState{
		DeviceID:       "BD-TEST",
		AccessMode:     AccessUnattended,
		AccessPassword: "secret12",
	}

	if headlessConsent(Branding{}, st)("session", "operator") {
		t.Fatal("unattended mode must not bypass branding approval")
	}
	if !headlessConsent(Branding{AllowUnattended: true}, st)("session", "operator") {
		t.Fatal("approved unattended mode should be allowed in headless mode")
	}

	st.AccessMode = AccessSupervised
	if headlessConsent(Branding{AllowUnattended: true}, st)("session", "operator") {
		t.Fatal("supervised mode must be denied without a local UI")
	}

	st.AccessMode = AccessDisabled
	if headlessConsent(Branding{AllowUnattended: true}, st)("session", "operator") {
		t.Fatal("disabled access mode must never be allowed")
	}
}

func TestUnattendedPolicyRequiresUsablePassword(t *testing.T) {
	st := &AppState{
		DeviceID:       "BD-TEST",
		AccessMode:     AccessUnattended,
		AccessPassword: " \t ",
	}
	brand := Branding{AllowUnattended: true}
	policy := accessPolicyFor(brand, st)

	if policy.allowsUnattended() {
		t.Fatal("whitespace-only password must not enable unattended access")
	}
	if !policy.requiresConsent() {
		t.Fatal("passwordless unattended policy must require consent")
	}
	if policy.allowsSignalHost(true) {
		t.Fatal("passwordless unattended policy must not expose a headless relay")
	}
	if headlessConsent(brand, st)("session", "operator") {
		t.Fatal("headless CDAP consent must not bypass a missing password")
	}
}

func TestSignalHostPolicyDisablesUnsafeModes(t *testing.T) {
	st := &AppState{
		DeviceID:       "BD-TEST",
		AccessMode:     AccessSupervised,
		AccessPassword: "secret12",
	}
	brand := Branding{AllowUnattended: true}

	if !accessPolicyFor(brand, st).allowsSignalHost(false) {
		t.Fatal("supervised GUI mode should permit a consent-gated signal host")
	}
	if accessPolicyFor(brand, st).allowsSignalHost(true) {
		t.Fatal("supervised headless mode must not expose a signal host")
	}

	st.AccessMode = AccessDisabled
	if accessPolicyFor(brand, st).allowsSignalHost(false) {
		t.Fatal("disabled mode must not expose a signal host")
	}

	st.AccessMode = AccessUnattended
	if !accessPolicyFor(brand, st).allowsSignalHost(true) {
		t.Fatal("approved unattended headless mode should expose a signal host")
	}

	brand.Capabilities = &CapabilityFlags{Desktop: boolRef(false)}
	if accessPolicyFor(brand, st).allowsSignalHost(false) {
		t.Fatal("desktop-disabled branding must not expose a signal host")
	}
}

func TestNewSignalHostSupportsOnlySafeHeadlessMode(t *testing.T) {
	st := &AppState{
		DeviceID:       "BD-TEST",
		AccessMode:     AccessUnattended,
		AccessPassword: "secret12",
	}
	brand := Branding{
		ServerAddress:   "https://desk.example.test",
		AllowUnattended: true,
	}
	host, reason := newSignalHost(brand, st, true, signalHostCallbacks{})
	if host == nil || reason != "" {
		t.Fatalf("safe headless host = %v, reason = %q", host, reason)
	}

	st.AccessMode = AccessDisabled
	host, reason = newSignalHost(brand, st, true, signalHostCallbacks{})
	if host != nil || reason == "" {
		t.Fatalf("disabled headless host = %v, reason = %q", host, reason)
	}
}

func TestIncomingCapabilitiesIncludeAudioAndRestartPolicy(t *testing.T) {
	caps := Branding{Capabilities: &CapabilityFlags{
		Audio:   boolRef(false),
		Restart: boolRef(false),
	}}.incomingCapabilities()
	if caps.Audio || caps.Restart {
		t.Fatalf("audio=%v restart=%v, want both disabled", caps.Audio, caps.Restart)
	}
}
