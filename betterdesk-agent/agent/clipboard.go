package agent

import (
	"log"
	"os/exec"
	"runtime"
	"strings"
)

// ClipboardHandler provides cross-platform text clipboard access
// using OS commands (no CGo required).
type ClipboardHandler struct{}

// NewClipboardHandler creates a new handler.
func NewClipboardHandler() *ClipboardHandler {
	return &ClipboardHandler{}
}

// Get returns the current clipboard text content.
func (ch *ClipboardHandler) Get() string {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbpaste")
	case "linux", "freebsd", "openbsd", "netbsd":
		if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-selection", "clipboard", "-o")
		} else if _, err := exec.LookPath("xsel"); err == nil {
			cmd = exec.Command("xsel", "--clipboard", "--output")
		} else if _, err := exec.LookPath("wl-paste"); err == nil {
			cmd = exec.Command("wl-paste", "--no-newline")
		} else {
			log.Printf("[clipboard] No clipboard tool found (install xclip, xsel, or wl-paste)")
			return ""
		}
	case "windows":
		cmd = exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", "Get-Clipboard")
	default:
		return ""
	}

	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		log.Printf("[clipboard] Get failed: %v", err)
		return ""
	}
	return strings.TrimRight(string(out), "\r\n")
}

// Set writes text to the system clipboard.
func (ch *ClipboardHandler) Set(text string) {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "linux", "freebsd", "openbsd", "netbsd":
		if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		} else if _, err := exec.LookPath("xsel"); err == nil {
			cmd = exec.Command("xsel", "--clipboard", "--input")
		} else if _, err := exec.LookPath("wl-copy"); err == nil {
			cmd = exec.Command("wl-copy")
		} else {
			log.Printf("[clipboard] No clipboard tool found")
			return
		}
	case "windows":
		cmd = exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", "Set-Clipboard -Value $input")
	default:
		return
	}

	hideConsole(cmd)
	cmd.Stdin = strings.NewReader(text)
	if err := cmd.Run(); err != nil {
		log.Printf("[clipboard] Set failed: %v", err)
	}
}
