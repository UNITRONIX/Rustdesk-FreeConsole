package agent

import "strings"

// normalizeDesktopControl keeps control names stable before they reach an OS
// action. A remote peer must not bypass a deny rule through casing or padding.
func normalizeDesktopControl(control string) string {
	return strings.ToLower(strings.TrimSpace(control))
}

// unsupportedDesktopControlReason returns a fixed, non-secret reason for
// controls the agent cannot truthfully enforce. The policy is intentionally
// local: a valid desktop session or remote peer must not turn a missing host
// implementation into a privileged action.
func unsupportedDesktopControlReason(control string) string {
	switch normalizeDesktopControl(control) {
	case "privacy_mode":
		return "privacy mode is unavailable on this host"
	case "block_input":
		// The legacy session flag blocks remote injection, not the local user's
		// keyboard and mouse. It must not be presented as local-input blocking.
		return "local input blocking is unavailable on this host"
	case "restart_device":
		// Restart is not bound to the passive desktop grant and must remain
		// unavailable until a dedicated, policy-authorized host path exists.
		return "remote restart is unavailable on this host"
	case "recording":
		return "recording is unavailable on this host"
	default:
		return ""
	}
}
