package main

// hostFeature names a remote-host operation. These values intentionally match
// the session-grant vocabulary where it exists, so a future adapter can use
// the same policy result for both CDAP and compatibility transports.
type hostFeature string

const (
	hostFeatureScreenView   hostFeature = "screen_view"
	hostFeatureInput        hostFeature = "input"
	hostFeatureClipboard    hostFeature = "clipboard"
	hostFeatureFiles        hostFeature = "files"
	hostFeatureTerminal     hostFeature = "terminal"
	hostFeatureChat         hostFeature = "chat"
	hostFeatureAudio        hostFeature = "system_audio"
	hostFeatureMultiMonitor hostFeature = "multi_monitor"
	hostFeaturePrivacyMode  hostFeature = "privacy_mode"
	hostFeatureBlockInput   hostFeature = "block_input"
	hostFeatureRestart      hostFeature = "restart"
	hostFeatureRecording    hostFeature = "recording"
)

var hostFeatureOrder = []hostFeature{
	hostFeatureScreenView,
	hostFeatureInput,
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
}

// hostFeatureReason is deliberately a small, fixed vocabulary. It is safe to
// retain in local audit logs because it never contains a credential, grant,
// clipboard content, terminal input, or other request payload.
type hostFeatureReason string

const (
	hostFeatureEnabled                      hostFeatureReason = "enabled"
	hostFeatureDisabledByBranding           hostFeatureReason = "disabled_by_branding"
	hostFeatureGrantBindingUnavailable      hostFeatureReason = "session_grant_binding_unavailable"
	hostFeatureAudioPipelineUnavailable     hostFeatureReason = "audio_pipeline_unavailable"
	hostFeatureSingleCaptureSource          hostFeatureReason = "single_capture_source_only"
	hostFeaturePrivacyCurtainUnavailable    hostFeatureReason = "privacy_curtain_unavailable"
	hostFeatureLocalInputBlockUnavailable   hostFeatureReason = "local_input_block_unavailable"
	hostFeatureRestartGrantBindingMissing   hostFeatureReason = "restart_grant_binding_unavailable"
	hostFeatureRecordingPipelineUnavailable hostFeatureReason = "recording_pipeline_unavailable"
	hostFeatureUnknown                      hostFeatureReason = "unknown_feature"
)

// hostFeatureStatus is the complete local decision for one feature.
type hostFeatureStatus struct {
	Feature hostFeature
	Allowed bool
	Reason  hostFeatureReason
}

// hostCapabilityPolicy is the one conservative source of truth for what the
// Support Agent may expose. A feature is allowed only when branding permits it
// and the current host path can enforce that permission locally.
type hostCapabilityPolicy struct {
	statuses map[hostFeature]hostFeatureStatus
}

func hostCapabilityPolicyFor(branding Branding) hostCapabilityPolicy {
	flags := branding.Capabilities
	policy := hostCapabilityPolicy{statuses: make(map[hostFeature]hostFeatureStatus, len(hostFeatureOrder))}

	// Desktop capture and remote input share the current CDAP configuration
	// switch. They are the only features with an enforceable admission path:
	// the CDAP adapter binds them to a signed passive grant, while the relay
	// host applies its local password, TOTP, and consent checks.
	desktopEnabled := hostFeatureRequested(featureFlag(flags, hostFeatureScreenView), true)
	policy.set(hostFeatureScreenView, desktopEnabled, hostFeatureDisabledByBranding)
	policy.set(hostFeatureInput, desktopEnabled, hostFeatureDisabledByBranding)

	// These handlers exist in the shared agent, but their independent CDAP
	// messages are not bound to the Support Agent's signed session grant or
	// active-session state. Advertising them would create a policy bypass.
	policy.setUnavailable(hostFeatureClipboard, featureFlag(flags, hostFeatureClipboard), hostFeatureGrantBindingUnavailable)
	policy.setUnavailable(hostFeatureFiles, featureFlag(flags, hostFeatureFiles), hostFeatureGrantBindingUnavailable)
	policy.setUnavailable(hostFeatureTerminal, featureFlag(flags, hostFeatureTerminal), hostFeatureGrantBindingUnavailable)
	policy.setUnavailable(hostFeatureChat, featureFlag(flags, hostFeatureChat), hostFeatureGrantBindingUnavailable)

	// The remaining operations have no enforceable host implementation. They
	// must stay denied even if a signed branding profile requests them.
	policy.setUnavailable(hostFeatureAudio, featureFlag(flags, hostFeatureAudio), hostFeatureAudioPipelineUnavailable)
	policy.setUnavailable(hostFeatureMultiMonitor, featureFlag(flags, hostFeatureMultiMonitor), hostFeatureSingleCaptureSource)
	policy.setUnavailable(hostFeaturePrivacyMode, featureFlag(flags, hostFeaturePrivacyMode), hostFeaturePrivacyCurtainUnavailable)
	policy.setUnavailable(hostFeatureBlockInput, featureFlag(flags, hostFeatureBlockInput), hostFeatureLocalInputBlockUnavailable)
	policy.setUnavailable(hostFeatureRestart, featureFlag(flags, hostFeatureRestart), hostFeatureRestartGrantBindingMissing)
	policy.setUnavailable(hostFeatureRecording, featureFlag(flags, hostFeatureRecording), hostFeatureRecordingPipelineUnavailable)

	return policy
}

func featureFlag(flags *CapabilityFlags, feature hostFeature) *bool {
	if flags == nil {
		return nil
	}
	switch feature {
	case hostFeatureScreenView, hostFeatureInput:
		return flags.Desktop
	case hostFeatureClipboard:
		return flags.Clipboard
	case hostFeatureFiles:
		return flags.Files
	case hostFeatureTerminal:
		return flags.Terminal
	case hostFeatureChat:
		return flags.Chat
	case hostFeatureAudio:
		return flags.Audio
	case hostFeatureMultiMonitor:
		return flags.MultiMonitor
	case hostFeaturePrivacyMode:
		return flags.PrivacyMode
	case hostFeatureBlockInput:
		return flags.BlockInput
	case hostFeatureRestart:
		return flags.Restart
	case hostFeatureRecording:
		return flags.Recording
	default:
		return nil
	}
}

func hostFeatureRequested(flag *bool, defaultValue bool) bool {
	if flag == nil {
		return defaultValue
	}
	return *flag
}

func (p hostCapabilityPolicy) set(feature hostFeature, allowed bool, disabledReason hostFeatureReason) {
	reason := hostFeatureEnabled
	if !allowed {
		reason = disabledReason
	}
	p.statuses[feature] = hostFeatureStatus{
		Feature: feature,
		Allowed: allowed,
		Reason:  reason,
	}
}

func (p hostCapabilityPolicy) setUnavailable(feature hostFeature, profileFlag *bool, unavailableReason hostFeatureReason) {
	reason := unavailableReason
	if profileFlag != nil && !*profileFlag {
		reason = hostFeatureDisabledByBranding
	}
	p.statuses[feature] = hostFeatureStatus{
		Feature: feature,
		Allowed: false,
		Reason:  reason,
	}
}

func (p hostCapabilityPolicy) allows(feature hostFeature) bool {
	status, ok := p.statuses[feature]
	return ok && status.Allowed
}

func (p hostCapabilityPolicy) status(feature hostFeature) hostFeatureStatus {
	if status, ok := p.statuses[feature]; ok {
		return status
	}
	return hostFeatureStatus{Feature: feature, Reason: hostFeatureUnknown}
}

func (p hostCapabilityPolicy) statusesInOrder() []hostFeatureStatus {
	statuses := make([]hostFeatureStatus, 0, len(hostFeatureOrder))
	for _, feature := range hostFeatureOrder {
		statuses = append(statuses, p.status(feature))
	}
	return statuses
}

// hostFeatureAuditRecord contains only code-defined capability decisions.
// It intentionally has no field that could carry request content or secrets.
type hostFeatureAuditRecord struct {
	Feature  string `json:"feature"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

func (p hostCapabilityPolicy) auditRecords() []hostFeatureAuditRecord {
	statuses := p.statusesInOrder()
	records := make([]hostFeatureAuditRecord, 0, len(statuses))
	for _, status := range statuses {
		decision := "denied"
		if status.Allowed {
			decision = "allowed"
		}
		records = append(records, hostFeatureAuditRecord{
			Feature:  string(status.Feature),
			Decision: decision,
			Reason:   string(status.Reason),
		})
	}
	return records
}
