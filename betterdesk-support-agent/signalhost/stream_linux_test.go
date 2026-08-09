//go:build linux

package signalhost

import "testing"

func TestLinuxCaptureUsesInheritedX11Display(t *testing.T) {
	t.Setenv("DISPLAY", ":42")

	strats := platformCaptureStrategies(15)
	if len(strats) == 0 {
		t.Fatal("expected X11 capture strategy")
	}
	found := false
	for _, a := range strats[0].Args {
		if a == ":42" {
			found = true
		}
	}
	if !found {
		t.Fatalf("capture args = %#v, want display :42", strats[0].Args)
	}
}

func TestLinuxCaptureDoesNotGuessDisplayOnPureWayland(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	t.Setenv("DISPLAY", "")

	if strats := platformCaptureStrategies(15); strats != nil {
		t.Fatalf("platformCaptureStrategies() = %#v, want nil screenshot fallback", strats)
	}
}
