package main

import (
	"log"
	"os"
	"runtime"
	"strings"
)

// antiDebugChecks performs lightweight debugger heuristics on release builds.
// Failures are logged only — false positives on VMs/containers are common.
func antiDebugChecks() {
	if !isReleaseBuild() {
		return
	}
	if runtime.GOOS == "linux" {
		if data, err := os.ReadFile("/proc/self/status"); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "TracerPid:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 && fields[1] != "0" {
						log.Printf("[hardening] tracer detected (TracerPid=%s)", fields[1])
					}
				}
			}
		}
	}
}
