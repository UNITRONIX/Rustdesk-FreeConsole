package cdap

import (
	"encoding/json"
	"testing"
)

func TestBetterDeskDesktopManifestCapabilitiesAreAccepted(t *testing.T) {
	manifest := &Manifest{
		ManifestVersion: "1.0",
		Device: ManifestDevice{
			Name: "BetterDesk Desktop",
			Type: "desktop",
		},
		Capabilities: []string{
			"remote_desktop",
			"keyboard_input",
			"mouse_input",
			"multi_monitor",
			"unattended_access",
			"clipboard",
			"file_transfer",
			"audio",
		},
	}

	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("BetterDesk Desktop capability contract rejected: %v", err)
	}
}

func TestDesktopStartPayloadSupportsViewOnlySessions(t *testing.T) {
	payload := []byte(`{"session_id":"desk-1","width":1280,"height":720,"quality":70,"fps":30,"view_only":true}`)
	var start DesktopStartPayload
	if err := json.Unmarshal(payload, &start); err != nil {
		t.Fatalf("decode desktop_start: %v", err)
	}
	if !start.ViewOnly {
		t.Fatal("expected view_only to be preserved")
	}
}
