package agent

import (
	"encoding/json"
	"log"
	"os/exec"
	"runtime"
	"sync"
)

// desktopSessionFlags holds per-session operator control toggles.
type desktopSessionFlags struct {
	mu                sync.RWMutex
	blockInput        bool
	privacyMode       bool
	clipboardDisabled bool
	lockAfterSession  bool
}

func (f *desktopSessionFlags) set(control string, enabled bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch control {
	case "block_input":
		f.blockInput = enabled
	case "privacy_mode":
		f.privacyMode = enabled
	case "disable_clipboard":
		f.clipboardDisabled = enabled
	case "lock_after_session":
		f.lockAfterSession = enabled
	}
}

func (f *desktopSessionFlags) isBlocked() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.blockInput
}

func (f *desktopSessionFlags) isPrivacy() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.privacyMode
}

func (f *desktopSessionFlags) isClipboardDisabled() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.clipboardDisabled
}

func (f *desktopSessionFlags) shouldLockAfter() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.lockAfterSession
}

func (a *Agent) sessionFlags(sessionID string) *desktopSessionFlags {
	if sessionID == "" {
		sessionID = "_default"
	}
	if v, ok := a.desktopFlags.Load(sessionID); ok {
		return v.(*desktopSessionFlags)
	}
	f := &desktopSessionFlags{}
	actual, _ := a.desktopFlags.LoadOrStore(sessionID, f)
	return actual.(*desktopSessionFlags)
}

func (a *Agent) handleDesktopControl(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
		Control   string `json:"control"`
		Enabled   bool   `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		log.Printf("[agent] desktop_control decode: %v", err)
		return
	}
	switch p.Control {
	case "lock_screen":
		if err := lockWorkstation(); err != nil {
			log.Printf("[agent] lock_screen failed: %v", err)
		}
	case "restart_device":
		if err := restartHost(); err != nil {
			log.Printf("[agent] restart_device failed: %v", err)
		}
	case "block_input", "privacy_mode", "disable_clipboard", "lock_after_session":
		a.sessionFlags(p.SessionID).set(p.Control, p.Enabled)
		log.Printf("[agent] desktop_control %s=%v session=%s", p.Control, p.Enabled, p.SessionID)
	case "show_cursor", "quality_set":
		// Acknowledged — capture pipeline handles quality/cursor separately.
	default:
		if a.cfg.LogLevel == "debug" {
			log.Printf("[agent] unknown desktop_control: %s", p.Control)
		}
	}
}

func lockWorkstation() error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32.exe", "user32.dll,LockWorkStation").Start()
	case "linux":
		if err := exec.Command("loginctl", "lock-session").Start(); err == nil {
			return nil
		}
		return exec.Command("xdg-screensaver", "lock").Start()
	case "darwin":
		return exec.Command("pmset", "displaysleepnow").Start()
	default:
		return nil
	}
}

func restartHost() error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("shutdown", "/r", "/t", "5", "/c", "BetterDesk remote restart").Start()
	case "linux":
		if err := exec.Command("systemctl", "reboot").Start(); err == nil {
			return nil
		}
		return exec.Command("reboot").Start()
	case "darwin":
		return exec.Command("osascript", "-e", `tell app "System Events" to restart`).Start()
	default:
		return nil
	}
}
