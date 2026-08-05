package main

import "strings"

// incomingCapabilities adapts the enforceable Support Agent feature policy to
// the switches exposed by the shared CDAP engine and signal host.
type incomingCapabilities struct {
	Desktop   bool
	Files     bool
	Clipboard bool
	Audio     bool
	Terminal  bool
	Restart   bool
}

func (b Branding) incomingCapabilities() incomingCapabilities {
	policy := hostCapabilityPolicyFor(b)
	return incomingCapabilities{
		Desktop:   policy.allows(hostFeatureScreenView) && policy.allows(hostFeatureInput),
		Files:     policy.allows(hostFeatureFiles),
		Clipboard: policy.allows(hostFeatureClipboard),
		Audio:     policy.allows(hostFeatureAudio),
		Terminal:  policy.allows(hostFeatureTerminal),
		Restart:   policy.allows(hostFeatureRestart),
	}
}

// incomingAccessPolicy combines the user-selected access mode with the
// immutable bundle policy. Treat unsupported or stale unattended settings as
// supervised rather than granting an unattended session.
type incomingAccessPolicy struct {
	mode               string
	passwordConfigured bool
	unattended         bool
	capabilities       incomingCapabilities
}

func accessPolicyFor(b Branding, st *AppState) incomingAccessPolicy {
	_, mode, password, _ := st.Snapshot()
	return incomingAccessPolicy{
		mode:               mode,
		passwordConfigured: strings.TrimSpace(password) != "",
		unattended:         mode == AccessUnattended && b.AllowUnattended,
		capabilities:       b.incomingCapabilities(),
	}
}

// allowsUnattended is the complete local unattended-access predicate. A
// branded unattended mode without a usable local password must fail closed;
// otherwise CDAP and relay could disagree about whether a session is allowed.
func (p incomingAccessPolicy) allowsUnattended() bool {
	return p.unattended && p.passwordConfigured
}

func (p incomingAccessPolicy) requiresConsent() bool {
	return !p.allowsUnattended()
}

func (p incomingAccessPolicy) allowsSignalHost(headless bool) bool {
	if p.mode == AccessDisabled || !p.capabilities.Desktop || !p.passwordConfigured {
		return false
	}
	return !headless || p.allowsUnattended()
}

func (p incomingAccessPolicy) signalHostDisabledReason(headless bool) string {
	switch {
	case p.mode == AccessDisabled:
		return "access mode is disabled"
	case !p.capabilities.Desktop:
		return "desktop capability is disabled by branding"
	case !p.passwordConfigured:
		return "no local access password is configured"
	case headless && p.mode == AccessUnattended && !p.unattended:
		return "unattended access is disabled by branding"
	case headless:
		return "headless mode has no local consent UI; approved unattended access is required"
	default:
		return ""
	}
}
