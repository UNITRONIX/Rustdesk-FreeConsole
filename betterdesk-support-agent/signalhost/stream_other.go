//go:build !linux && !windows && !darwin

package signalhost

func ffmpegStreamArgs(_ int) []string {
	return nil
}
