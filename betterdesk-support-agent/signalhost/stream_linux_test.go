//go:build linux

package signalhost

import "testing"

func TestLinuxFFmpegStreamUsesInheritedX11Display(t *testing.T) {
	t.Setenv("DISPLAY", ":42")

	args := ffmpegStreamArgs(15)
	if len(args) == 0 {
		t.Fatal("expected X11 capture arguments")
	}
	if got, want := args[8], ":42"; got != want {
		t.Fatalf("capture display = %q, want %q", got, want)
	}
}

func TestLinuxFFmpegStreamDoesNotGuessDisplayOnPureWayland(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	t.Setenv("DISPLAY", "")

	if args := ffmpegStreamArgs(15); args != nil {
		t.Fatalf("ffmpegStreamArgs() = %#v, want nil screenshot fallback", args)
	}
}
