//go:build !linux && !windows && !darwin

package signalhost

func platformCaptureStrategies(_ int) []captureStrategy {
	return nil
}
