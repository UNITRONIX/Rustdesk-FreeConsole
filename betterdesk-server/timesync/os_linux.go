//go:build linux

package timesync

import (
	"os/exec"
	"strings"
)

func readOSClockSynced() *bool {
	out, err := exec.Command("timedatectl", "show", "-p", "NTPSynchronized", "--value").Output()
	if err != nil {
		return nil
	}
	v := strings.TrimSpace(string(out))
	if v == "yes" {
		t := true
		return &t
	}
	if v == "no" {
		f := false
		return &f
	}
	return nil
}
