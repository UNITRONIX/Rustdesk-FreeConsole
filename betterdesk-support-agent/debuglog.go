//go:build !release

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const debugSessionID = "7fbd11"

// debugLog writes NDJSON diagnostics for debug-mode investigation.
// Never log secrets (tokens, passwords) — use lengths and booleans only.
func debugLog(hypothesisID, location, message string, data map[string]any) {
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

	paths := []string{}
	if p := os.Getenv("BETTERDESK_DEBUG_LOG"); p != "" {
		paths = append(paths, p)
	}
	paths = append(paths, filepath.Join(stateDir(), "debug-"+debugSessionID+".log"))

	seen := map[string]bool{}
	for _, p := range paths {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		if dir := filepath.Dir(p); dir != "" {
			_ = os.MkdirAll(dir, 0o700)
		}
		f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			continue
		}
		if err := f.Chmod(0o600); err != nil {
			_ = f.Close()
			continue
		}
		_, _ = f.Write(line)
		_ = f.Close()
	}
}
