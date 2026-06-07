package agent

import (
	"encoding/json"
	"fmt"
	"log"
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
	return injectInput(evt)
}

// handleDesktopInput dispatches a desktop input event to the platform-specific
// injection implementation.
func (a *Agent) handleDesktopInput(msg *Message) {
	if !a.cfg.Screenshot {
		// Input injection requires screen capture permission as a proxy gate.
		return
	}

	var evt InputEvent
	if err := json.Unmarshal(msg.Payload, &evt); err != nil {
		log.Printf("[input] Parse error: %v", err)
		return
	}

	if err := injectInput(&evt); err != nil {
		log.Printf("[input] Injection failed (%s): %v", evt.Type, err)
		_ = a.sendMessage("desktop_input_error", map[string]any{
			"session_id": evt.SessionID,
			"type":       evt.Type,
			"message":    err.Error(),
		})
	}
}
