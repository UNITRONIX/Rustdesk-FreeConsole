//go:build darwin

package agent

import (
	"fmt"
	"os/exec"
)

// captureDevice returns the ffmpeg input format for screen capture on macOS.
func captureDevice() string {
	return "avfoundation"
}

// captureInput returns the ffmpeg AVFoundation screen capture source.
// "Capture screen 0" selects the primary display.
func captureInput() string {
	return "Capture screen 0"
}

// captureFFmpegInputArgs returns ffmpeg input arguments for macOS screen capture.
func captureFFmpegInputArgs(fps int) []string {
	return []string{
		"-f", "avfoundation",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "Capture screen 0",
	}
}

// captureFFmpegStrategies returns the (single) macOS capture strategy.
func captureFFmpegStrategies(fps int, _ *DesktopStreamer) []CaptureStrategy {
	return []CaptureStrategy{{
		Name: "avfoundation",
		Args: captureFFmpegInputArgs(fps),
	}}
}

// checkScreenRecordingPermission runs a quick no-op screencapture to detect
// whether the Screen Recording permission has been granted on macOS 10.15+.
// Returns a non-nil error with instructions if the permission is missing.
func checkScreenRecordingPermission() error {
	// screencapture -x suppresses the shutter sound.
	// Writing to /dev/null is effectively a no-op that still triggers the
	// permission check. An exit code ≠1 means the permission was denied.
	cmd := exec.Command("screencapture", "-x", "-t", "png", "/dev/null")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf(
			"screen recording permission denied — open System Settings > Privacy & Security > Screen Recording and enable BetterDesk Agent (exit: %v)",
			err,
		)
	}
	return nil
}
