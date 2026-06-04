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
	if !st.IsEnrolled() {
		return fmt.Errorf("device not enrolled")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("message required")
	}

	if engine != nil {
		if err := engine.RequestHelp(st, message); err == nil {
			return nil
		} else if !isHelpGatewayError(err) {
			return err
		}
	}
	return sendHelpViaAPI(brand, st, message)
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
