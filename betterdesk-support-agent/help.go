package main

import (
	"fmt"
	"strings"
)

// SendHelpRequest delivers a help request through the CDAP gateway (Go server).
func SendHelpRequest(engine *Engine, brand Branding, st *AppState, message string) error {
	if !brand.HasConnection() {
		return fmt.Errorf("no server address configured")
	}
	if !st.IsEnrolled() {
		return fmt.Errorf("device not enrolled")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("message required")
	}
	if engine == nil {
		return fmt.Errorf("engine not ready")
	}
	if err := engine.RequestHelp(st, message); err != nil {
		return err
	}
	return nil
}
