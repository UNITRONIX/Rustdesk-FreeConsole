package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHostCapabilityPolicyAllowsOnlyGrantBoundDesktopAndInput(t *testing.T) {
	policy := hostCapabilityPolicyFor(Branding{})

	for _, feature := range []hostFeature{hostFeatureScreenView, hostFeatureInput} {
		status := policy.status(feature)
		if !status.Allowed || status.Reason != hostFeatureEnabled {
			t.Fatalf("%s status = %#v, want allowed/enabled", feature, status)
		}
	}

	for _, feature := range []hostFeature{
		hostFeatureClipboard,
		hostFeatureFiles,
		hostFeatureTerminal,
		hostFeatureChat,
		hostFeatureAudio,
		hostFeatureMultiMonitor,
		hostFeaturePrivacyMode,
		hostFeatureBlockInput,
		hostFeatureRestart,
		hostFeatureRecording,
	} {
		if status := policy.status(feature); status.Allowed {
			t.Fatalf("%s must stay denied until its host path is enforceable: %#v", feature, status)
		}
	}
}

func TestHostCapabilityPolicyFailsClosedWhenBrandingRequestsUnavailableFeatures(t *testing.T) {
	enabled := true
	disabled := false
	branding := Branding{Capabilities: &CapabilityFlags{
		Desktop:      &disabled,
		Files:        &enabled,
		Clipboard:    &enabled,
		Audio:        &enabled,
		Terminal:     &enabled,
		Chat:         &enabled,
		MultiMonitor: &enabled,
		PrivacyMode:  &enabled,
		BlockInput:   &enabled,
		Restart:      &enabled,
		Recording:    &enabled,
	}}

	policy := hostCapabilityPolicyFor(branding)
	if status := policy.status(hostFeatureScreenView); status.Allowed || status.Reason != hostFeatureDisabledByBranding {
		t.Fatalf("screen_view status = %#v, want branding denial", status)
	}
	if status := policy.status(hostFeatureInput); status.Allowed || status.Reason != hostFeatureDisabledByBranding {
		t.Fatalf("input status = %#v, want branding denial", status)
	}

	wantReasons := map[hostFeature]hostFeatureReason{
		hostFeatureClipboard:    hostFeatureGrantBindingUnavailable,
		hostFeatureFiles:        hostFeatureGrantBindingUnavailable,
		hostFeatureTerminal:     hostFeatureGrantBindingUnavailable,
		hostFeatureChat:         hostFeatureGrantBindingUnavailable,
		hostFeatureAudio:        hostFeatureAudioPipelineUnavailable,
		hostFeatureMultiMonitor: hostFeatureSingleCaptureSource,
		hostFeaturePrivacyMode:  hostFeaturePrivacyCurtainUnavailable,
		hostFeatureBlockInput:   hostFeatureLocalInputBlockUnavailable,
		hostFeatureRestart:      hostFeatureRestartGrantBindingMissing,
		hostFeatureRecording:    hostFeatureRecordingPipelineUnavailable,
	}
	for feature, reason := range wantReasons {
		status := policy.status(feature)
		if status.Allowed || status.Reason != reason {
			t.Fatalf("%s status = %#v, want denied/%s", feature, status, reason)
		}
	}

	caps := branding.incomingCapabilities()
	if caps.Desktop || caps.Files || caps.Clipboard || caps.Audio || caps.Terminal || caps.Restart {
		t.Fatalf("shared-agent switches must fail closed: %#v", caps)
	}
}

func TestHostCapabilityAuditRecordsContainOnlyFixedPolicyMetadata(t *testing.T) {
	records := hostCapabilityPolicyFor(Branding{}).auditRecords()
	if len(records) != len(hostFeatureOrder) {
		t.Fatalf("got %d audit records, want %d", len(records), len(hostFeatureOrder))
	}

	encoded, err := json.Marshal(records)
	if err != nil {
		t.Fatalf("marshal audit records: %v", err)
	}
	for _, forbidden := range []string{"password", "token", "grant_presentation", "clipboard_data", "terminal_data", "chat_text"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("audit records leaked forbidden field %q: %s", forbidden, encoded)
		}
	}
	for _, record := range records {
		if record.Feature == "" || record.Decision == "" || record.Reason == "" {
			t.Fatalf("incomplete audit record: %#v", record)
		}
	}
}

func TestHostCapabilityAuditTransportIsAllowlisted(t *testing.T) {
	if got := normalizeHostCapabilityAuditTransport(hostCapabilityAuditTransportCDAP); got != hostCapabilityAuditTransportCDAP {
		t.Fatalf("cdap transport = %q", got)
	}
	if got := normalizeHostCapabilityAuditTransport(hostCapabilityAuditTransportSignal); got != hostCapabilityAuditTransportSignal {
		t.Fatalf("signal transport = %q", got)
	}
	if got := normalizeHostCapabilityAuditTransport("remote-secret-token"); got != "unknown" {
		t.Fatalf("unrecognized transport = %q, want unknown", got)
	}
}

func TestSignalHostReceivesOnlyNonSecretCapabilityAudit(t *testing.T) {
	st := &AppState{
		DeviceID:       "BD-TEST",
		AccessMode:     AccessUnattended,
		AccessPassword: "secret12",
	}
	var got []hostFeatureAuditRecord
	host, reason := newSignalHost(
		Branding{ServerAddress: "https://desk.example.test", AllowUnattended: true},
		st,
		true,
		signalHostCallbacks{
			audit: func(policy hostCapabilityPolicy) {
				got = policy.auditRecords()
			},
		},
	)
	if host == nil || reason != "" {
		t.Fatalf("newSignalHost() = (%v, %q), want host without reason", host, reason)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal signal-host audit: %v", err)
	}
	if strings.Contains(string(encoded), st.AccessPassword) {
		t.Fatalf("signal-host audit leaked access password: %s", encoded)
	}
	if len(got) != len(hostFeatureOrder) {
		t.Fatalf("got %d audit records, want %d", len(got), len(hostFeatureOrder))
	}
}
