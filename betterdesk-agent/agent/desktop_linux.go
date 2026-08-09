//go:build linux

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// isWaylandSession returns true when running under a Wayland compositor.
func isWaylandSession() bool {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	if strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland") {
		return true
	}
	return false
}

// hasX11Display returns true when an X11 display is available.
// This includes XWayland sessions running inside Wayland compositors.
func hasX11Display() bool {
	return strings.TrimSpace(os.Getenv("DISPLAY")) != ""
}

// x11Display returns the X11 DISPLAY value. Callers must first confirm that
// an X11 display is present rather than guessing ":0" from a service context.
func x11Display() string {
	return strings.TrimSpace(os.Getenv("DISPLAY"))
}

const desktopPortalBusName = "org.freedesktop.portal.Desktop"

type waylandPortalReadiness struct {
	Portal   bool
	PipeWire bool
}

// detectWaylandPortalReadiness probes only local session prerequisites. A
// ready portal/PipeWire session is not a capture capability by itself: this
// agent still needs an in-process OpenPipeWireRemote file-descriptor bridge
// before it can offer a live portal stream.
func detectWaylandPortalReadiness() waylandPortalReadiness {
	return waylandPortalReadiness{
		Portal:   desktopPortalServiceAvailable(),
		PipeWire: pipeWireSocketAvailable(os.Getenv("XDG_RUNTIME_DIR")),
	}
}

func pipeWireSocketAvailable(runtimeDir string) bool {
	if strings.TrimSpace(runtimeDir) == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(runtimeDir, "pipewire-0"))
	return err == nil && info.Mode()&os.ModeSocket != 0
}

func desktopPortalServiceAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	// SessionBus returns a package-managed shared connection; it must not be
	// closed here. The bounded calls below do not activate a portal or prompt.
	conn, err := dbus.SessionBus()
	if err != nil {
		return false
	}

	var owned bool
	call := conn.BusObject().CallWithContext(
		ctx,
		"org.freedesktop.DBus.NameHasOwner",
		0,
		desktopPortalBusName,
	)
	if call.Err == nil && call.Store(&owned) == nil && owned {
		return true
	}

	var activatable []string
	call = conn.BusObject().CallWithContext(
		ctx,
		"org.freedesktop.DBus.ListActivatableNames",
		0,
	)
	return call.Err == nil && call.Store(&activatable) == nil && portalServiceListed(activatable)
}

func portalServiceListed(names []string) bool {
	for _, name := range names {
		if name == desktopPortalBusName {
			return true
		}
	}
	return false
}

// captureDevice returns a verified direct ffmpeg input format. Pure Wayland
// has no such path in this agent: a PipeWire portal node cannot be consumed
// safely without passing OpenPipeWireRemote's file descriptor to the capture
// process.
func captureDevice() string {
	if !hasX11Display() {
		return ""
	}
	return "x11grab"
}

// captureInput returns the direct ffmpeg input source, if one is available.
func captureInput() string {
	if !hasX11Display() {
		return ""
	}
	return x11Display()
}

// captureFFmpegInputArgs returns a verified direct ffmpeg input. Streaming
// uses captureFFmpegStrategies; pure Wayland deliberately returns nil rather
// than claiming a fictitious PipeWire node 0 is capturable.
func captureFFmpegInputArgs(fps int) []string {
	if !hasX11Display() {
		return nil
	}
	return []string{
		"-f", "x11grab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", x11Display(),
	}
}

// captureFFmpegStrategies returns an ordered list of ffmpeg capture pipelines
// for the current Linux session. The streamer tries them in order until one
// produces frames.
//
// On pure Wayland, use streamFallback instead. It delegates to screenshot
// tools that can prove they captured a frame (grim/wayshot/portal-aware
// desktop tools) instead of assuming a PipeWire node or elevated DRM access.
func captureFFmpegStrategies(fps int, _ *DesktopStreamer) []CaptureStrategy {
	if !hasX11Display() {
		return nil
	}
	name := "x11grab"
	if isWaylandSession() {
		name = "x11grab(XWayland; X11 windows only)"
	}
	return []CaptureStrategy{{
		Name: name,
		Args: []string{
			"-f", "x11grab",
			"-framerate", fmt.Sprintf("%d", fps),
			"-i", x11Display(),
		},
	}}
}
