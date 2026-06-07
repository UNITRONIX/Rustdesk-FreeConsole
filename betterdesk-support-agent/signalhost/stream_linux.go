//go:build linux

package signalhost

import "fmt"

func ffmpegStreamArgs(fps int) []string {
	return []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "x11grab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", ":0.0",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-pix_fmt", "yuv420p",
		"-f", "h264",
		"-",
	}
}
