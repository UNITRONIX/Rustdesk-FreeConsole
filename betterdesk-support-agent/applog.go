package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	appLogMu sync.Mutex
)

type appLogEntry struct {
	Time    string         `json:"time"`
	Level   string         `json:"level"`
	Event   string         `json:"event"`
	Message string         `json:"message,omitempty"`
	Fields  map[string]any `json:"fields,omitempty"`
}

func appLogPath() string {
	return filepath.Join(stateDir(), "support-agent.log")
}

func writeAppLog(level, event, message string, fields map[string]any) {
	entry := appLogEntry{
		Time:    time.Now().UTC().Format(time.RFC3339),
		Level:   level,
		Event:   event,
		Message: message,
		Fields:  fields,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')

	appLogMu.Lock()
	defer appLogMu.Unlock()

	path := appLogPath()
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o700)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	// OpenFile's mode only applies on creation. Repair a pre-existing log so
	// release diagnostics containing device/session metadata never remain
	// world-readable after an older build or manual file replacement.
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return
	}
	_, _ = f.Write(line)
	_ = f.Close()
}

func appLogInfo(event, message string, fields map[string]any) {
	writeAppLog("info", event, message, fields)
	log.Printf("[support-agent] %s: %s", event, message)
}

func appLogWarn(event, message string, fields map[string]any) {
	writeAppLog("warn", event, message, fields)
	log.Printf("[support-agent] %s: %s", event, message)
}

func appLogError(event, message string, fields map[string]any) {
	writeAppLog("error", event, message, fields)
	log.Printf("[support-agent] %s: %s", event, message)
}

func logConnectionTest(res ExtendedConnCheck) {
	appLogInfo("connection_test", fmt.Sprintf("cdap=%v api=%v enroll=%v",
		res.CDAP.OK, res.API.OK, res.Enrollment.OK), map[string]any{
		"cdap_detail":       res.CDAP.Detail,
		"api_detail":        res.API.Detail,
		"enrollment_detail": res.Enrollment.Detail,
	})
}
