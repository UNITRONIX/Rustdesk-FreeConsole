//go:build windows

package signalhost

import "fmt"

func ffmpegStreamArgs(fps int) []string {
	return []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "gdigrab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "desktop",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-pix_fmt", "yuv420p",
		"-f", "h264",
		"-",
	}
}
