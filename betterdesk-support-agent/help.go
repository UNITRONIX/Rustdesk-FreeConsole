package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
)

// SendHelpRequest delivers a help request through CDAP, with REST fallback.
func SendHelpRequest(engine *Engine, brand Branding, st *AppState, message string) error {
	if !brand.HasConnection() {
		return fmt.Errorf("no server address configured")
	}
	enrolled := st.IsEnrolled()
	// #region agent log
	debugLog("H4", "help.go:SendHelpRequest", "entry", map[string]any{
		"is_enrolled": enrolled, "engine_running": engine != nil && engine.Running(),
		"api_base": apiBaseURL(brand),
	})
	// #endregion
	if !enrolled {
		return fmt.Errorf("device not enrolled")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("message required")
	}

	if engine != nil {
		cdapErr := engine.RequestHelp(st, message)
		if cdapErr == nil {
			// #region agent log
			debugLog("H7", "help.go:SendHelpRequest", "cdap help ok", nil)
			// #endregion
			return nil
		}
		if !isHelpGatewayError(cdapErr) {
			// #region agent log
			debugLog("H7", "help.go:SendHelpRequest", "cdap help fatal", map[string]any{"error": cdapErr.Error()})
			// #endregion
			return cdapErr
		}
		// #region agent log
		debugLog("H7", "help.go:SendHelpRequest", "cdap help fallback", map[string]any{"error": cdapErr.Error()})
		// #endregion
	}
	err := sendHelpViaAPI(brand, st, message)
	// #region agent log
	if err != nil {
		debugLog("H7", "help.go:SendHelpRequest", "rest help failed", map[string]any{"error": err.Error()})
	} else {
		debugLog("H7", "help.go:SendHelpRequest", "rest help ok", nil)
	}
	// #endregion
	return err
}

func isHelpGatewayError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "gateway not connected") ||
		strings.Contains(s, "not connected to gateway") ||
		strings.Contains(s, "connect to gateway") ||
		strings.Contains(s, "engine not ready")
}

func sendHelpViaAPI(brand Branding, st *AppState, message string) error {
	deviceID, _, _, _ := st.Snapshot()
	st.mu.Lock()
	token := st.DeviceToken
	st.mu.Unlock()

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	payload := map[string]string{
		"device_id":    deviceID,
		"device_token": token,
		"hostname":     hostname,
		"message":      message,
	}
	url := apiBaseURL(brand) + "/devices/self/help-request"
	var ack struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	code, err := apiJSON(http.MethodPost, url, payload, &ack)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("help request failed (HTTP %d)", code)
	}
	return nil
}
