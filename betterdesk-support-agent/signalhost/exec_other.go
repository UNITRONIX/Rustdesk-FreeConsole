//go:build !windows

package signalhost

import "os/exec"

func hideConsole(cmd *exec.Cmd) {}
