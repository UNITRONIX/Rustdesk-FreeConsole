//go:build !linux && !windows && !darwin

package agent

func audioCaptureArgs() []string { return nil }
