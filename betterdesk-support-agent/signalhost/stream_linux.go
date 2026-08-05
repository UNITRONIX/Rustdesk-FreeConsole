//go:build linux

package signalhost

import (
	"fmt"
	"os"
	"strings"
)

func ffmpegStreamArgs(fps int) []string {
	display := linuxX11CaptureDisplay()
	if display == "" {
		// Do not guess :0.0 from a service or pure-Wayland context. Returning
		// nil makes the relay use its screenshot fallback, which can use
		// portal-aware tools when available. A real PipeWire portal stream
		// needs OpenPipeWireRemote FD handoff and is not claimed here.
		return nil
	}
	return []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "x11grab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", display,
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-pix_fmt", "yuv420p",
		"-f", "h264",
		"-",
	}
}

// linuxX11CaptureDisplay returns a display only when the agent inherited an
// explicit X11/XWayland session. On a pure Wayland desktop, $DISPLAY is empty
// and ffmpegStreamArgs must not imply that a PipeWire node or X root exists.
func linuxX11CaptureDisplay() string {
	return strings.TrimSpace(os.Getenv("DISPLAY"))
}
