package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"runtime"
	"strings"
)

// machineFingerprint returns a stable hardware-oriented identifier for this
// machine. It is sent to the server as the enrollment "uuid" anchor and is
// distinct from the per-installation secret mixed into device_id.
func machineFingerprint() string {
	parts := []string{runtime.GOOS, runtime.GOARCH}
	if id := platformMachineID(); id != "" {
		parts = append(parts, id)
	}
	if serial := platformBoardSerial(); serial != "" {
		parts = append(parts, serial)
	}
	if len(parts) <= 2 {
		if h, err := os.Hostname(); err == nil && h != "" {
			parts = append(parts, h)
		}
	}
	if len(parts) <= 2 {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:16])
}

// legacyMachineSeed returns the pre-v2 machine seed used for uuid on older
// support-agent builds. Kept for migration of enrolled devices.
func legacyMachineSeed() string {
	switch runtime.GOOS {
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if b, err := os.ReadFile(p); err == nil {
				if id := strings.TrimSpace(string(b)); id != "" {
					return id
				}
			}
		}
	case "windows":
		if v := os.Getenv("COMPUTERNAME"); v != "" {
			return v
		}
	case "darwin":
		if h, err := os.Hostname(); err == nil {
			return h
		}
	}
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return ""
}
