//go:build darwin

package signalhost

import "fmt"

func platformCaptureStrategies(fps int) []captureStrategy {
	return []captureStrategy{{
		Name: "avfoundation",
		Args: []string{
			"-f", "avfoundation",
			"-framerate", fmt.Sprintf("%d", fps),
			"-i", "1:none",
		},
	}}
}
