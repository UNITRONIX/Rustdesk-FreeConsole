//go:build darwin

package main

import (
	"os/exec"
	"strings"
)

func platformMachineID() string {
	out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "IOPlatformUUID") {
			if i := strings.Index(line, `"`); i >= 0 {
				rest := line[i+1:]
				if j := strings.Index(rest, `"`); j >= 0 {
					return strings.TrimSpace(rest[:j])
				}
			}
		}
	}
	return ""
}

func platformBoardSerial() string {
	out, err := exec.Command("system_profiler", "SPHardwareDataType").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Serial Number") {
			if i := strings.Index(line, ":"); i >= 0 {
				return strings.TrimSpace(line[i+1:])
			}
		}
	}
	return ""
}
