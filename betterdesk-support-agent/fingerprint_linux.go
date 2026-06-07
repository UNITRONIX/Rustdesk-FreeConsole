//go:build linux

package main

import (
	"os"
	"strings"
)

func platformMachineID() string {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			if id := strings.TrimSpace(string(b)); id != "" {
				return id
			}
		}
	}
	return ""
}

func platformBoardSerial() string {
	for _, p := range []string{
		"/sys/class/dmi/id/board_serial",
		"/sys/class/dmi/id/product_uuid",
	} {
		if b, err := os.ReadFile(p); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" && !isPlaceholderSerial(s) {
				return s
			}
		}
	}
	return ""
}

func isPlaceholderSerial(s string) bool {
	switch strings.ToLower(s) {
	case "", "none", "not specified", "to be filled by o.e.m.", "default string", "0123456789":
		return true
	}
	return false
}
