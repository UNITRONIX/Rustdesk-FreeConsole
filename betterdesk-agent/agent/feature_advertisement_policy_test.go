package agent

import (
	"encoding/json"
	"testing"
)

func TestManifestDoesNotAdvertiseTerminalCommandsWhenDisabled(t *testing.T) {
	manifest := BuildManifest(
		&Config{Screenshot: true, Terminal: false},
		&SystemCollector{cachedInfo: &SystemInfo{}},
		"test",
	)
	capabilities, ok := manifest["capabilities"].([]string)
	if !ok {
		t.Fatalf("capabilities = %#v, want []string", manifest["capabilities"])
	}

	if hasCapability(capabilities, "commands") {
		t.Fatalf("terminal-disabled agent advertised commands: %v", capabilities)
	}
	if !hasCapability(capabilities, "remote_desktop") {
		t.Fatalf("desktop-enabled agent did not advertise remote_desktop: %v", capabilities)
	}
}

func TestUnsupportedDesktopControlsAreDeniedBeforeHostActions(t *testing.T) {
	tests := []struct {
		control string
		want    string
	}{
		{control: "privacy_mode", want: "privacy mode is unavailable on this host"},
		{control: " block_input ", want: "local input blocking is unavailable on this host"},
		{control: "RESTART_DEVICE", want: "remote restart is unavailable on this host"},
		{control: "recording", want: "recording is unavailable on this host"},
	}
	for _, tt := range tests {
		t.Run(tt.control, func(t *testing.T) {
			if got := unsupportedDesktopControlReason(tt.control); got != tt.want {
				t.Fatalf("unsupportedDesktopControlReason(%q) = %q, want %q", tt.control, got, tt.want)
			}
		})
	}

	if got := unsupportedDesktopControlReason("disable_clipboard"); got != "" {
		t.Fatalf("supported session control denied: %q", got)
	}
}

func TestBlockInputControlIsDeniedWithoutChangingSessionState(t *testing.T) {
	a := &Agent{}
	a.desktopStreams.Store("desktop-1", &DesktopStreamer{})
	defer a.desktopStreams.Delete("desktop-1")

	payload, err := json.Marshal(map[string]any{
		"session_id": "desktop-1",
		"control":    "block_input",
		"enabled":    true,
	})
	if err != nil {
		t.Fatalf("marshal control payload: %v", err)
	}
	a.handleDesktopControl(&Message{Payload: payload})

	if _, exists := a.desktopFlags.Load("desktop-1"); exists {
		t.Fatal("denied block_input control must not create session flags")
	}
	if remoteInputInjectionBlocked() {
		t.Fatal("denied block_input control must not block remote input")
	}
}

func hasCapability(capabilities []string, want string) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}
