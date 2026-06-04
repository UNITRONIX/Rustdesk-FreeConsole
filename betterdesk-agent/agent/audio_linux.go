//go:build linux

package agent

// audioCaptureArgs returns ffmpeg input arguments for Linux PulseAudio/PipeWire.
func audioCaptureArgs() []string {
	return []string{
		"-f", "pulse",
		"-i", "default",
	}
}
