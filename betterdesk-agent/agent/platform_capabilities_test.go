package agent

import (
	"encoding/json"
	"testing"
)

func TestCodecAnswerDoesNotAdvertiseUnavailableAudio(t *testing.T) {
	answer := codecAnswerPayload("desktop-1", []string{CodecH264, CodecMJPEG}, (&Agent{}).audioCodecCapability())

	if got := answer["audio_codec"]; got != CodecNone {
		t.Fatalf("audio_codec = %q, want %q", got, CodecNone)
	}
	if got := answer["video_codec"]; got != CodecH264 {
		t.Fatalf("video_codec = %q, want %q", got, CodecH264)
	}
}

func TestManifestDoesNotAdvertiseUnavailableAudio(t *testing.T) {
	manifest := BuildManifest(&Config{}, &SystemCollector{cachedInfo: &SystemInfo{}}, "test")
	capabilities, ok := manifest["capabilities"].([]string)
	if !ok {
		t.Fatalf("capabilities = %#v, want []string", manifest["capabilities"])
	}
	for _, capability := range capabilities {
		if capability == "audio" {
			t.Fatal("manifest must not advertise unavailable audio")
		}
	}
}

func TestBlockInputStopsSessionAndExportedInjectionPaths(t *testing.T) {
	a := &Agent{}
	a.desktopStreams.Store("desktop-1", &DesktopStreamer{})
	if !a.setSessionControl("desktop-1", "block_input", true) {
		t.Fatal("expected active-session block_input control to be applied")
	}
	t.Cleanup(func() {
		a.finishDesktopStream("desktop-1", nil)
	})

	if !a.isRemoteInputBlocked("desktop-1") {
		t.Fatal("expected desktop session input to be blocked")
	}
	if !remoteInputInjectionBlocked() {
		t.Fatal("expected exported input path to be blocked")
	}
	if err := InjectInputEvent(&InputEvent{}); err == nil {
		t.Fatal("expected exported input injection to be rejected")
	}

	if !a.setSessionControl("desktop-1", "block_input", false) {
		t.Fatal("expected active-session block_input control to clear")
	}
	if a.isRemoteInputBlocked("desktop-1") {
		t.Fatal("expected session input block to clear")
	}
	if remoteInputInjectionBlocked() {
		t.Fatal("expected exported input block to clear")
	}
}

func TestClipboardDisableBlocksScopedAndUnscopedOperations(t *testing.T) {
	a := &Agent{}
	a.desktopStreams.Store("desktop-1", &DesktopStreamer{})
	t.Cleanup(func() {
		a.desktopStreams.Delete("desktop-1")
		a.finishDesktopSession("desktop-1")
	})

	if !a.setSessionControl("desktop-1", "disable_clipboard", true) {
		t.Fatal("expected active-session disable_clipboard control to be applied")
	}
	if !a.isClipboardOperationBlocked("desktop-1") {
		t.Fatal("expected scoped clipboard operation to be blocked")
	}
	if !a.isClipboardOperationBlocked("") {
		t.Fatal("expected unscoped clipboard operation to be blocked")
	}

	if !a.setSessionControl("desktop-1", "disable_clipboard", false) {
		t.Fatal("expected active-session disable_clipboard control to clear")
	}
	if a.isClipboardOperationBlocked("desktop-1") {
		t.Fatal("expected scoped clipboard operation to be allowed")
	}
	if a.isClipboardOperationBlocked("") {
		t.Fatal("expected unscoped clipboard operation to be allowed")
	}
}

func TestOldDesktopStreamCannotClearReplacementControls(t *testing.T) {
	a := &Agent{}
	oldStream := &DesktopStreamer{}
	newStream := &DesktopStreamer{}
	a.desktopStreams.Store("desktop-1", oldStream)
	if !a.setSessionControl("desktop-1", "block_input", true) {
		t.Fatal("expected old-session block_input control to be applied")
	}

	a.desktopControlMu.Lock()
	a.resetSessionFlags("desktop-1")
	a.desktopStreams.Store("desktop-1", newStream)
	a.desktopControlMu.Unlock()
	if !a.setSessionControl("desktop-1", "block_input", true) {
		t.Fatal("expected replacement-session block_input control to be applied")
	}
	t.Cleanup(func() {
		a.finishDesktopStream("desktop-1", newStream)
	})

	a.finishDesktopStream("desktop-1", oldStream)
	current, active := a.desktopStreams.Load("desktop-1")
	if !active || current != newStream {
		t.Fatal("old capture cleanup removed the replacement stream")
	}
	if !a.isRemoteInputBlocked("desktop-1") {
		t.Fatal("old capture cleanup removed replacement input controls")
	}
}

func TestInactiveSessionControlCannotCreateGlobalInputBlock(t *testing.T) {
	a := &Agent{}
	payload, err := json.Marshal(map[string]any{
		"session_id": "inactive-session",
		"control":    "block_input",
		"enabled":    true,
	})
	if err != nil {
		t.Fatalf("marshal control payload: %v", err)
	}

	a.handleDesktopControl(&Message{Payload: payload})
	if remoteInputInjectionBlocked() {
		t.Fatal("inactive session control must not block exported input")
	}
	if _, found := a.desktopFlags.Load("inactive-session"); found {
		t.Fatal("inactive session control must not create retained flags")
	}
}

func TestPrivacyModeIsNotRetainedAsAnUnsupportedControl(t *testing.T) {
	a := &Agent{}
	payload, err := json.Marshal(map[string]any{
		"session_id": "desktop-1",
		"control":    "privacy_mode",
		"enabled":    true,
	})
	if err != nil {
		t.Fatalf("marshal control payload: %v", err)
	}

	a.handleDesktopControl(&Message{Payload: payload})
	if _, found := a.desktopFlags.Load("desktop-1"); found {
		t.Fatal("privacy mode must not be retained without an enforceable privacy curtain")
	}
}

func TestCurrentCaptureMonitorListDoesNotClaimPhysicalSelection(t *testing.T) {
	monitors := currentCaptureMonitorList()
	if len(monitors) != 1 {
		t.Fatalf("got %d advertised capture sources, want 1", len(monitors))
	}
	if monitors[0].Index != 0 || monitors[0].Name != "Current capture" || !monitors[0].Primary {
		t.Fatalf("unexpected capture source: %#v", monitors[0])
	}
}
