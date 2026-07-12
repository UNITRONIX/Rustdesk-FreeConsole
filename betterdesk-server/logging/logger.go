// Package logging provides structured log formatting for BetterDesk server.
// Supports "text" (default stdlib format) and "json" (structured JSON lines).
// JSON format outputs one JSON object per line with timestamp, level, and message fields.
package logging

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Format represents the log output format.
type Format string

const (
	FormatText Format = "text"
	FormatJSON Format = "json"
)

// JSONWriter is an io.Writer that converts log lines to JSON format.
// It implements io.Writer so it can be used as log.SetOutput target.
type JSONWriter struct {
	mu  sync.Mutex
	out io.Writer
}

// jsonEntry represents a single structured log entry.
type jsonEntry struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Component string `json:"component,omitempty"`
	Message   string `json:"message"`
}

// NewJSONWriter creates a new JSON log writer wrapping the given output.
func NewJSONWriter(out io.Writer) *JSONWriter {
	return &JSONWriter{out: out}
}

// Write implements io.Writer. Parses the log line and outputs JSON.
// Expected input format from log.Printf: "2026/02/22 10:30:45.123456 [component] message"
// The stdlib logger adds the timestamp prefix; we parse it and emit JSON.
func (w *JSONWriter) Write(p []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	line := strings.TrimSpace(string(p))
	if line == "" {
		return len(p), nil
	}

	entry := jsonEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Level:     "info",
	}

	// Strip stdlib timestamp prefix if present (e.g., "2026/02/22 10:30:45.123456 ")
	msg := stripTimestamp(line)

	// Extract component from [brackets]
	if idx := strings.Index(msg, "["); idx >= 0 {
		if end := strings.Index(msg[idx:], "]"); end >= 0 {
			entry.Component = msg[idx+1 : idx+end]
			msg = strings.TrimSpace(msg[idx+end+1:])
		}
	}

	// Detect log level from message content
	entry.Level = detectLevel(msg)
	entry.Message = msg

	data, err := json.Marshal(entry)
	if err != nil {
		// Fallback: write raw line
		return w.out.Write(p)
	}
	data = append(data, '\n')
	_, err = w.out.Write(data)
	return len(p), err
}

// stripTimestamp removes the stdlib log timestamp prefix.
// Handles formats: "2006/01/02 15:04:05 " and "2006/01/02 15:04:05.000000 "
func stripTimestamp(s string) string {
	// Look for date pattern at start: YYYY/MM/DD HH:MM:SS
	if len(s) < 20 {
		return s
	}
	// Check if starts with a date-like pattern
	if s[4] == '/' && s[7] == '/' && s[10] == ' ' && s[13] == ':' && s[16] == ':' {
		// Find end of timestamp (after seconds or microseconds)
		idx := 19 // "2006/01/02 15:04:05"
		if idx < len(s) && s[idx] == '.' {
			// Skip microseconds
			for idx < len(s) && s[idx] != ' ' {
				idx++
			}
		}
		if idx < len(s) && s[idx] == ' ' {
			return s[idx+1:]
		}
	}
	return s
}

// detectLevel infers the log level from message keywords.
func detectLevel(msg string) string {
	upper := strings.ToUpper(msg)
	switch {
	case strings.HasPrefix(upper, "FATAL"):
		return "fatal"
	case strings.HasPrefix(upper, "ERROR"), strings.Contains(upper, " ERROR:"), strings.Contains(upper, " ERROR "):
		return "error"
	case strings.HasPrefix(upper, "WARN"), strings.Contains(upper, " WARN:"), strings.Contains(upper, " WARN "):
		return "warn"
	case strings.HasPrefix(upper, "DEBUG"):
		return "debug"
	default:
		return "info"
	}
}

// Setup configures the global logger based on the format and minimum level strings.
// level: error | warn | info | debug (default info).
// Returns a cleanup function (currently a no-op, reserved for future use).
func Setup(format string, level string) func() {
	minLevel := ParseLevel(level)
	filter := &levelFilter{minLevel: minLevel, inner: os.Stderr}

	switch Format(strings.ToLower(format)) {
	case FormatJSON:
		jw := NewJSONWriter(filter)
		log.SetOutput(jw)
		log.SetFlags(0) // No stdlib prefix — JSONWriter handles timestamps
		return func() {}
	default:
		// text format — use default stdlib logging with level filter
		log.SetOutput(filter)
		log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
		return func() {}
	}
}

// ParseLevel normalizes a log level string (error, warn, info, debug).
func ParseLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "error", "fatal":
		return "error"
	case "warn", "warning":
		return "warn"
	case "debug":
		return "debug"
	default:
		return "info"
	}
}

func levelRank(level string) int {
	switch strings.ToLower(level) {
	case "fatal", "error":
		return 0
	case "warn", "warning":
		return 1
	case "debug":
		return 3
	default:
		return 2
	}
}

func shouldEmit(msgLevel, minLevel string) bool {
	return levelRank(msgLevel) <= levelRank(minLevel)
}

// levelFilter drops log lines below the configured minimum level.
type levelFilter struct {
	minLevel string
	inner    io.Writer
}

func (f *levelFilter) Write(p []byte) (n int, err error) {
	line := strings.TrimSpace(string(p))
	if line == "" {
		return len(p), nil
	}
	msg := stripTimestamp(line)
	if !shouldEmit(detectLevel(msg), f.minLevel) {
		return len(p), nil
	}
	return f.inner.Write(p)
}

// Logf is a helper for structured logging with component prefix.
func Logf(component, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[%s] %s", component, msg)
}
