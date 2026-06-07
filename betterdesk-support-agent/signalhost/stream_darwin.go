//go:build darwin

package signalhost

import "fmt"

func ffmpegStreamArgs(fps int) []string {
	return []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "avfoundation",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "1:none",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-pix_fmt", "yuv420p",
		"-f", "h264",
		"-",
	}
}
