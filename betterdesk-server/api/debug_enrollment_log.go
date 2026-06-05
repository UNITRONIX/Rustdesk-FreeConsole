package api

import (
	"encoding/json"
	"os"
	"time"
)

const debugSessionID = "7fbd11"

// debugEnrollmentLog writes NDJSON diagnostics for debug-mode enrollment tracing.
// Never log secrets — use booleans and lengths only.
func debugEnrollmentLog(hypothesisID, location, message string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	payload := map[string]any{
		"sessionId":    debugSessionID,
		"timestamp":    time.Now().UnixMilli(),
		"hypothesisId": hypothesisID,
		"location":     location,
		"message":      message,
		"data":         data,
	}
	line, err := json.Marshal(payload)
	if err != nil {
		return
	}
	line = append(line, '\n')
	path := "/home/unitronix/Dokumenty/GitHub/BetterDesk/.cursor/debug-7fbd11.log"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = f.Write(line)
	_ = f.Close()
}
