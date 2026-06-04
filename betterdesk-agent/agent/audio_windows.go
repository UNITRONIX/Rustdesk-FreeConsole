//go:build windows

package agent

// audioCaptureArgs returns ffmpeg input arguments for Windows WASAPI/dshow.
func audioCaptureArgs() []string {
	return []string{
		"-f", "dshow",
		"-i", "audio=virtual-audio-capturer",
	}
}
