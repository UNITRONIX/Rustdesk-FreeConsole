//go:build !linux && !windows && !darwin

package main

import "os"

func platformMachineID() string {
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return ""
}

func platformBoardSerial() string {
	return ""
}
