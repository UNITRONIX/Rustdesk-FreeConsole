//go:build !windows

package agent

import "os/exec"

func hideConsole(cmd *exec.Cmd) {}
