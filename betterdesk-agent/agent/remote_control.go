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
	clipboardDisabled bool
	lockAfterSession  bool
}

// remoteInputBlockers also protects the exported InjectInputEvent helper,
// which is used by the support-agent transport and therefore has no CDAP
// session parameter. Blocking is intentionally conservative: if any active
// remote desktop session blocks input, no remote path may inject locally.
var remoteInputBlockers sync.Map // *desktopSessionFlags → struct{}

func (f *desktopSessionFlags) set(control string, enabled bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch control {
	case "block_input":
		f.blockInput = enabled
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

func normalizeDesktopSessionID(sessionID string) string {
	if sessionID == "" {
		return "default"
	}
	return sessionID
}

func (a *Agent) sessionFlags(sessionID string) *desktopSessionFlags {
	sessionID = normalizeDesktopSessionID(sessionID)
	if v, ok := a.desktopFlags.Load(sessionID); ok {
		return v.(*desktopSessionFlags)
	}
	f := &desktopSessionFlags{}
	actual, _ := a.desktopFlags.LoadOrStore(sessionID, f)
	return actual.(*desktopSessionFlags)
}

func (a *Agent) resetSessionFlags(sessionID string) {
	sessionID = normalizeDesktopSessionID(sessionID)
	if old, loaded := a.desktopFlags.LoadAndDelete(sessionID); loaded {
		remoteInputBlockers.Delete(old.(*desktopSessionFlags))
	}
	a.desktopFlags.Store(sessionID, &desktopSessionFlags{})
}

func (a *Agent) lookupSessionFlags(sessionID string) (*desktopSessionFlags, bool) {
	v, ok := a.desktopFlags.Load(normalizeDesktopSessionID(sessionID))
	if !ok {
		return nil, false
	}
	return v.(*desktopSessionFlags), true
}

// setSessionControl applies a control only while its target desktop session is
// active. The mutex closes the race where a late block_input message could
// otherwise leave the exported, session-less injection path disabled after a
// session ended.
func (a *Agent) setSessionControl(sessionID, control string, enabled bool) bool {
	sessionID = normalizeDesktopSessionID(sessionID)
	a.desktopControlMu.Lock()
	defer a.desktopControlMu.Unlock()
	if _, active := a.desktopStreams.Load(sessionID); !active {
		return false
	}
	flags := a.sessionFlags(sessionID)
	if control == "block_input" {
		if enabled {
			// Register before changing the session flag so the exported,
			// session-less injection path cannot race an enable request.
			remoteInputBlockers.Store(flags, struct{}{})
		} else {
			remoteInputBlockers.Delete(flags)
		}
	}
	flags.set(control, enabled)
	return true
}

func remoteInputInjectionBlocked() bool {
	blocked := false
	remoteInputBlockers.Range(func(_, _ any) bool {
		blocked = true
		return false
	})
	return blocked
}

// isRemoteInputBlocked reports whether remote input injection is disabled for
// a desktop session. It deliberately does not attempt to suppress the local
// user's keyboard or mouse; doing that reliably requires a platform-specific
// accessibility/security boundary that this agent does not own.
func (a *Agent) isRemoteInputBlocked(sessionID string) bool {
	flags, ok := a.lookupSessionFlags(sessionID)
	return ok && flags.isBlocked()
}

// isClipboardOperationBlocked applies the per-session disable_clipboard flag.
// Widget commands have no desktop-session ID, so while any active desktop
// session disables clipboard access we deny those unscoped operations too.
// That conservative rule prevents a widget command from bypassing the
// operator's session-scoped control.
func (a *Agent) isClipboardOperationBlocked(sessionID string) bool {
	if sessionID != "" {
		flags, ok := a.lookupSessionFlags(sessionID)
		return ok && flags.isClipboardDisabled()
	}

	blocked := false
	a.desktopStreams.Range(func(key, _ any) bool {
		id, ok := key.(string)
		if !ok {
			return true
		}
		if flags, ok := a.lookupSessionFlags(id); ok && flags.isClipboardDisabled() {
			blocked = true
			return false
		}
		return true
	})
	return blocked
}

// finishDesktopSession applies end-of-session cleanup without a stream identity.
// It is used by tests and callers that already removed the target stream.
func (a *Agent) finishDesktopSession(sessionID string) {
	a.finishDesktopStream(sessionID, nil)
}

// finishDesktopStream applies the one end-of-session control the shared agent
// can enforce directly, then removes all session-scoped controls. The stream
// identity prevents an old capture goroutine from deleting controls belonging
// to a replacement session with the same ID. The lock command uses normal OS
// APIs and does not request elevation.
func (a *Agent) finishDesktopStream(sessionID string, expected *DesktopStreamer) {
	sessionID = normalizeDesktopSessionID(sessionID)
	a.desktopControlMu.Lock()
	if current, active := a.desktopStreams.Load(sessionID); expected != nil && active && current != expected {
		a.desktopControlMu.Unlock()
		return
	}
	flags, ok := a.lookupSessionFlags(sessionID)
	a.desktopStreams.Delete(sessionID)
	a.desktopFlags.Delete(sessionID)
	if ok {
		remoteInputBlockers.Delete(flags)
	}
	shouldLock := ok && flags.shouldLockAfter()
	a.desktopControlMu.Unlock()
	if !shouldLock {
		return
	}
	if err := lockWorkstation(); err != nil {
		log.Printf("[agent] lock_after_session failed for %s: %v", sessionID, err)
	}
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
	p.SessionID = normalizeDesktopSessionID(p.SessionID)
	p.Control = normalizeDesktopControl(p.Control)
	if reason := unsupportedDesktopControlReason(p.Control); reason != "" {
		log.Printf("[agent] denied desktop_control %s for session %s: %s", p.Control, p.SessionID, reason)
		return
	}
	switch p.Control {
	case "lock_screen":
		if err := lockWorkstation(); err != nil {
			log.Printf("[agent] lock_screen failed: %v", err)
		}
	case "disable_clipboard", "lock_after_session":
		if !a.setSessionControl(p.SessionID, p.Control, p.Enabled) {
			log.Printf("[agent] ignored desktop_control %s for inactive session %s", p.Control, p.SessionID)
			return
		}
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
		cmd := exec.Command("rundll32.exe", "user32.dll,LockWorkStation")
		hideConsole(cmd)
		return cmd.Start()
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
		cmd := exec.Command("shutdown", "/r", "/t", "5", "/c", "BetterDesk remote restart")
		hideConsole(cmd)
		return cmd.Start()
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
