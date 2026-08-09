//go:build linux

package agent

import (
	"net"
	"path/filepath"
	"strings"
	"testing"
)

func TestPureWaylandDoesNotAdvertiseUnverifiedPipeWireCapture(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	t.Setenv("DISPLAY", "")

	if got := captureDevice(); got != "" {
		t.Fatalf("captureDevice() = %q, want no direct capture device", got)
	}
	if got := captureInput(); got != "" {
		t.Fatalf("captureInput() = %q, want no direct capture input", got)
	}
	if got := captureFFmpegInputArgs(15); got != nil {
		t.Fatalf("captureFFmpegInputArgs() = %#v, want nil", got)
	}
	if got := captureFFmpegStrategies(15, nil); len(got) != 0 {
		t.Fatalf("captureFFmpegStrategies() = %#v, want no unverified strategy", got)
	}
}

func TestXWaylandStrategyIsExplicitlyLimited(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	t.Setenv("DISPLAY", ":1")

	strategies := captureFFmpegStrategies(15, nil)
	if len(strategies) != 1 {
		t.Fatalf("got %d capture strategies, want 1", len(strategies))
	}
	if !strings.Contains(strategies[0].Name, "XWayland") {
		t.Fatalf("strategy name %q must identify its XWayland limitation", strategies[0].Name)
	}
}

func TestX11CaptureUsesTheAgentSessionDisplay(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("XDG_SESSION_TYPE", "x11")
	t.Setenv("DISPLAY", ":42")

	if got := captureDevice(); got != "x11grab" {
		t.Fatalf("captureDevice() = %q, want x11grab", got)
	}
	if got := captureInput(); got != ":42" {
		t.Fatalf("captureInput() = %q, want :42", got)
	}
	args := captureFFmpegInputArgs(15)
	if got, want := args[len(args)-1], ":42"; got != want {
		t.Fatalf("capture display = %q, want %q", got, want)
	}
}

func TestHeadlessLinuxDoesNotGuessX11Display(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("XDG_SESSION_TYPE", "")
	t.Setenv("DISPLAY", "")

	if got := captureDevice(); got != "" {
		t.Fatalf("captureDevice() = %q, want no direct capture device", got)
	}
	if got := captureInput(); got != "" {
		t.Fatalf("captureInput() = %q, want no direct capture input", got)
	}
	if got := captureFFmpegInputArgs(15); got != nil {
		t.Fatalf("captureFFmpegInputArgs() = %#v, want nil", got)
	}
}

func TestPortalServiceListed(t *testing.T) {
	if !portalServiceListed([]string{"org.freedesktop.Notifications", desktopPortalBusName}) {
		t.Fatal("expected portal service to be detected in activatable names")
	}
	if portalServiceListed([]string{"org.freedesktop.Notifications"}) {
		t.Fatal("unexpected portal service detection")
	}
}

func TestPipeWireSocketAvailable(t *testing.T) {
	runtimeDir := t.TempDir()
	if pipeWireSocketAvailable(runtimeDir) {
		t.Fatal("unexpected PipeWire socket before socket creation")
	}

	socket := filepath.Join(runtimeDir, "pipewire-0")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatalf("create test PipeWire socket: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	if !pipeWireSocketAvailable(runtimeDir) {
		t.Fatal("expected PipeWire socket to be detected")
	}
}

func TestWaylandInputRequiresExplicitYdotoolFallback(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("XDG_SESSION_TYPE", "wayland")
	t.Setenv("DISPLAY", "")
	t.Setenv(waylandInputFallbackEnv, "")

	if got := linuxInputBackendForSession(); got != linuxInputBackendNoWaylandPortal {
		t.Fatalf("default pure-Wayland input backend = %d, want portal-required", got)
	}

	t.Setenv(waylandInputFallbackEnv, "ydotool")
	if got := linuxInputBackendForSession(); got != linuxInputBackendYdotool {
		t.Fatalf("opt-in pure-Wayland input backend = %d, want ydotool", got)
	}

	t.Setenv(waylandInputFallbackEnv, "")
	t.Setenv("DISPLAY", ":1")
	if got := linuxInputBackendForSession(); got != linuxInputBackendX11 {
		t.Fatalf("default XWayland input backend = %d, want X11", got)
	}
}
