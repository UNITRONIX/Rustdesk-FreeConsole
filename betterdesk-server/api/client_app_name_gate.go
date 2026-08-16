package api

import (
	"os"
	"strings"
)

const (
	envWindowsClientAppNameGate = "BETTERDESK_WINDOWS_CLIENT_APP_NAME_GATE"
	envAllowedWindowsAppNames   = "BETTERDESK_ALLOWED_WINDOWS_APP_NAMES"
	defaultAllowedAppName       = "DCS-Norway-RD"
	unsupportedWindowsClientMsg = "Unsupported Windows client. Use the DCS Norway Remote Desktop Client (or set BETTERDESK_WINDOWS_CLIENT_APP_NAME_GATE=false)."
)

// windowsClientAppNameGateEnabled defaults to true when unset.
func windowsClientAppNameGateEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(envWindowsClientAppNameGate)))
	if v == "" {
		return true
	}
	return v == "true" || v == "1" || v == "yes" || v == "y"
}

func allowedWindowsAppNames() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv(envAllowedWindowsAppNames))
	if raw == "" {
		raw = defaultAllowedAppName
	}
	out := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		if name != "" {
			out[name] = struct{}{}
		}
	}
	return out
}

func normalizeClientOS(osName string) string {
	return strings.ToLower(strings.TrimSpace(osName))
}

func isMobileClientOS(osName string) bool {
	o := normalizeClientOS(osName)
	return o == "android" || o == "ios" ||
		strings.Contains(o, "android") || strings.Contains(o, "iphone") ||
		strings.Contains(o, "ipad") || o == "ios"
}

func isWindowsClientOS(osName string) bool {
	o := normalizeClientOS(osName)
	return o == "windows" || strings.HasPrefix(o, "windows")
}

// rejectWindowsClientAppName returns a user-facing error when a Windows client
// must be blocked. Mobile (Android/iOS) is always allowed. Non-Windows desktop
// (linux/macos) is allowed. Empty OS is treated as unknown and allowed so
// older payloads do not break unexpectedly — Windows stock clients always send os=windows.
func rejectWindowsClientAppName(osName, appName string) string {
	if !windowsClientAppNameGateEnabled() {
		return ""
	}
	if isMobileClientOS(osName) {
		return ""
	}
	if !isWindowsClientOS(osName) {
		return ""
	}
	appName = strings.TrimSpace(appName)
	if _, ok := allowedWindowsAppNames()[appName]; ok {
		return ""
	}
	return unsupportedWindowsClientMsg
}
