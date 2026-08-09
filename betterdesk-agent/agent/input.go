package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// ── CDAP desktop_input payload ────────────────────────────────────────────

// InputEvent represents a single keyboard or mouse event from the operator.
// The payload mirrors the CDAP desktop_input message schema.
type InputEvent struct {
	SessionID string `json:"session_id"`
	Type      string `json:"type"` // mouse_move, mouse_click, mouse_scroll, key_press, key_release, text
	// Mouse fields
	X      int `json:"x"`
	Y      int `json:"y"`
	Button int `json:"button"` // 1=left, 2=right, 3=middle
	DeltaX int `json:"delta_x"`
	DeltaY int `json:"delta_y"`
	// Keyboard fields
	Key       string   `json:"key"`       // key name, e.g. "Return", "a", "ctrl"
	Text      string   `json:"text"`      // text to type (for "text" event type)
	Modifiers []string `json:"modifiers"` // ["ctrl", "shift", "alt", "super"]
	Pressed   bool     `json:"pressed"`   // true=key down, false=key up
}

// InjectInputEvent injects a keyboard or mouse event using the platform backend.
func InjectInputEvent(evt *InputEvent) error {
	if evt == nil {
		return fmt.Errorf("nil input event")
	}
	if remoteInputInjectionBlocked() {
		return fmt.Errorf("remote input is blocked")
	}
	return injectInput(evt)
}

// handleDesktopInput dispatches a desktop input event to the platform-specific
// injection implementation.
func (a *Agent) handleDesktopInput(msg *Message) {
	if !a.cfg.Screenshot {
		return
	}

	var evt InputEvent
	if err := json.Unmarshal(msg.Payload, &evt); err != nil {
		log.Printf("[input] Parse error: %v", err)
		return
	}
	evt.SessionID = normalizeDesktopSessionID(evt.SessionID)
	if !a.hasActiveDesktopStream(evt.SessionID) {
		return
	}
	if a.isRemoteInputBlocked(evt.SessionID) {
		const message = "remote input is blocked for this session"
		log.Printf("[input] Dropped %s for blocked session %s", evt.Type, evt.SessionID)
		a.sendDesktopInputError(&evt, message)
		return
	}

	if err := InjectInputEvent(&evt); err != nil {
		log.Printf("[input] Injection failed (%s): %v", evt.Type, err)
		a.sendDesktopInputError(&evt, err.Error())
	}
}

func (a *Agent) sendDesktopInputError(evt *InputEvent, message string) {
	if shouldEmitInputError(evt.SessionID, evt.Type, message) {
		_ = a.sendMessage("desktop_input_error", map[string]any{
			"session_id": evt.SessionID,
			"type":       evt.Type,
			"message":    message,
		})
	}
}

var (
	inputErrMu   sync.Mutex
	inputErrLast = map[string]time.Time{}
)

// shouldEmitInputError rate-limits operator-visible input failures.
// mouse_move failures are logged locally only — they fire continuously
// while the operator moves the pointer and would flood the RDClient console.
func shouldEmitInputError(sessionID, eventType, message string) bool {
	if eventType == "mouse_move" {
		return false
	}
	key := sessionID + "|" + message
	now := time.Now()
	inputErrMu.Lock()
	defer inputErrMu.Unlock()
	if t, ok := inputErrLast[key]; ok && now.Sub(t) < 5*time.Second {
		return false
	}
	inputErrLast[key] = now
	return true
}
