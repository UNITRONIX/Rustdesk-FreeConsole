//go:build darwin

package agent

// audioCaptureArgs returns ffmpeg input arguments for macOS avfoundation.
func audioCaptureArgs() []string {
	return []string{
		"-f", "avfoundation",
		"-i", ":0",
	}
}
