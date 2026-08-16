//go:build windows

package agent

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// hideConsole suppresses the console window for helper processes (PowerShell,
// ffmpeg wrappers, etc.) so remote sessions do not flood the desktop.
func hideConsole(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
