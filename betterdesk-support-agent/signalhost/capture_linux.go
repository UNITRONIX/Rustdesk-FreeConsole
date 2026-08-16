//go:build linux

package signalhost

import (
	"fmt"
	"os"
	"strings"
)

func platformCaptureStrategies(fps int) []captureStrategy {
	display := strings.TrimSpace(os.Getenv("DISPLAY"))
	if display == "" {
		return nil
	}
	return []captureStrategy{{
		Name: "x11grab",
		Args: []string{
			"-f", "x11grab",
			"-framerate", fmt.Sprintf("%d", fps),
			"-i", display,
		},
	}}
}
