//go:build windows

package signalhost

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func platformCaptureStrategies(fps int) []captureStrategy {
	var out []captureStrategy
	if ffmpegSupportsDDAGrab() {
		out = append(out, captureStrategy{
			Name: "ddagrab",
			Args: []string{
				"-f", "lavfi",
				"-i", fmt.Sprintf("ddagrab=output_idx=0:framerate=%d:draw_mouse=1,hwdownload,format=bgra", fps),
			},
		})
	}
	out = append(out, captureStrategy{
		Name: "gdigrab",
		Args: []string{
			"-f", "gdigrab",
			"-framerate", fmt.Sprintf("%d", fps),
			"-i", "desktop",
		},
	})
	return out
}

var (
	ddagrabProbeOnce sync.Once
	ddagrabAvailable bool
)

func ffmpegSupportsDDAGrab() bool {
	ddagrabProbeOnce.Do(func() {
		path, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "-hide_banner", "-filters")
		hideConsole(cmd)
		out, err := cmd.CombinedOutput()
		if err != nil || ctx.Err() != nil {
			return
		}
		ddagrabAvailable = filterListed(out, "ddagrab") &&
			filterListed(out, "hwdownload") &&
			filterListed(out, "format")
	})
	return ddagrabAvailable
}

func filterListed(output []byte, filter string) bool {
	for _, field := range strings.Fields(string(output)) {
		if field == filter {
			return true
		}
	}
	return false
}
