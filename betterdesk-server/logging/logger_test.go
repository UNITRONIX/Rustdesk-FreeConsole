package logging

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestJSONWriter(t *testing.T) {
	var buf bytes.Buffer
	w := NewJSONWriter(&buf)

	// Simulate a log line as produced by stdlib logger
	msg := "2026/02/22 10:30:45.123456 [api] HTTP listening on :21114\n"
	n, err := w.Write([]byte(msg))
	if err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if n != len(msg) {
		t.Fatalf("Expected n=%d, got %d", len(msg), n)
	}

	var entry jsonEntry
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("JSON parse error: %v\nRaw: %s", err, buf.String())
	}

	if entry.Component != "api" {
		t.Errorf("Expected component 'api', got %q", entry.Component)
	}
	if !strings.Contains(entry.Message, "HTTP listening") {
		t.Errorf("Expected message to contain 'HTTP listening', got %q", entry.Message)
	}
	if entry.Level != "info" {
		t.Errorf("Expected level 'info', got %q", entry.Level)
	}
	if entry.Timestamp == "" {
		t.Error("Expected non-empty timestamp")
	}
}

func TestDetectLevel(t *testing.T) {
	tests := []struct {
		msg      string
		expected string
	}{
		{"Starting server...", "info"},
		{"WARN: disk space low", "warn"},
		{"ERROR: connection refused", "error"},
		{"FATAL: cannot bind port", "fatal"},
		{"DEBUG: parsing packet", "debug"},
		{"Something with WARN in it", "warn"},
	}

	for _, tc := range tests {
		got := detectLevel(tc.msg)
		if got != tc.expected {
			t.Errorf("detectLevel(%q) = %q, want %q", tc.msg, got, tc.expected)
		}
	}
}

func TestStripTimestamp(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"2026/02/22 10:30:45.123456 [api] hello", "[api] hello"},
		{"2026/02/22 10:30:45 hello", "hello"},
		{"no timestamp here", "no timestamp here"},
		{"short", "short"},
	}

	for _, tc := range tests {
		got := stripTimestamp(tc.input)
		if got != tc.expected {
			t.Errorf("stripTimestamp(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

func TestSetupText(t *testing.T) {
	cleanup := Setup("text", "info")
	defer cleanup()
	// Should not panic
}

func TestSetupJSON(t *testing.T) {
	cleanup := Setup("json", "info")
	defer cleanup()
	// Restore default for other tests
	defer Setup("text", "info")
}

func TestLevelFilterSuppressesInfoWhenWarn(t *testing.T) {
	var buf bytes.Buffer
	filter := &levelFilter{minLevel: "warn", inner: &buf}
	_, err := filter.Write([]byte("2026/02/22 10:30:45.123456 [api] Starting server\n"))
	if err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected info line to be suppressed, got %q", buf.String())
	}
	_, err = filter.Write([]byte("2026/02/22 10:30:45.123456 [api] WARN: disk low\n"))
	if err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("expected warn line to pass through")
	}
}
