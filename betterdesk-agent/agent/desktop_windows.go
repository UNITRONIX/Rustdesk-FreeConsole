//go:build windows

package agent

import "fmt"

// captureDevice returns the ffmpeg input format for screen capture on Windows.
func captureDevice() string {
	return "gdigrab"
}

// captureInput returns the ffmpeg input source (the primary desktop).
func captureInput() string {
	return "desktop"
}

// captureFFmpegInputArgs returns ffmpeg input arguments for Windows screen capture.
func captureFFmpegInputArgs(fps int) []string {
	return []string{
		"-f", "gdigrab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "desktop",
	}
}

// captureFFmpegStrategies returns the (single) Windows capture strategy.
func captureFFmpegStrategies(fps int, _ *DesktopStreamer) []CaptureStrategy {
	return []CaptureStrategy{{
		Name: "gdigrab",
		Args: captureFFmpegInputArgs(fps),
	}}
}
