package audit

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLogAndRecent(t *testing.T) {
	l := NewLogger("")
	defer l.Close()

	l.Log(ActionPeerBanned, "api", "ABC123", map[string]string{"reason": "spam"})
	l.Log(ActionConfigChanged, "admin", "api_key", map[string]string{"old": "x", "new": "y"})
	l.Log(ActionBlocklistAdd, "api", "192.168.1.1", nil)

	if l.Total() != 3 {
		t.Fatalf("expected 3 total, got %d", l.Total())
	}

	recent := l.Recent(10)
	if len(recent) != 3 {
		t.Fatalf("expected 3 recent, got %d", len(recent))
	}

	// Newest first
	if recent[0].Action != ActionBlocklistAdd {
		t.Errorf("expected newest first, got %s", recent[0].Action)
	}
	if recent[2].Action != ActionPeerBanned {
		t.Errorf("expected oldest last, got %s", recent[2].Action)
	}
}

func TestRecentByAction(t *testing.T) {
	l := NewLogger("")
	defer l.Close()

	l.Log(ActionPeerBanned, "api", "A", nil)
	l.Log(ActionConfigChanged, "admin", "B", nil)
	l.Log(ActionPeerBanned, "api", "C", nil)
	l.Log(ActionBlocklistAdd, "api", "D", nil)

	bans := l.RecentByAction(ActionPeerBanned, 10)
	if len(bans) != 2 {
		t.Fatalf("expected 2 ban events, got %d", len(bans))
	}
	if bans[0].Target != "C" {
		t.Errorf("expected newest ban target C, got %s", bans[0].Target)
	}
}

func TestRingBufferOverflow(t *testing.T) {
	l := &Logger{
		events:  make([]Event, 5),
		maxSize: 5,
	}

	for i := 0; i < 8; i++ {
		l.Log(ActionConfigChanged, "test", "key", map[string]string{"i": string(rune('0' + i))})
	}

	if l.Total() != 8 {
		t.Fatalf("expected 8 total, got %d", l.Total())
	}

	// Should only have last 5 events
	recent := l.Recent(10)
	if len(recent) != 5 {
		t.Fatalf("expected 5 recent (ring buffer), got %d", len(recent))
	}
}

func TestFileLogging(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit.log")

	l := NewLogger(path)
	l.Log(ActionServerStart, "system", "", nil)
	l.Log(ActionPeerBanned, "api", "XYZ", map[string]string{"reason": "test"})
	l.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read audit log: %v", err)
	}

	content := string(data)
	if len(content) == 0 {
		t.Fatal("audit log file is empty")
	}

	// Should have 2 JSON lines
	lines := 0
	for _, b := range data {
		if b == '\n' {
			lines++
		}
	}
	if lines != 2 {
		t.Errorf("expected 2 lines in audit log, got %d", lines)
	}
}

func TestRedactDetailsForLog(t *testing.T) {
	out := redactDetailsForLog(map[string]string{
		"reason":   "spam",
		"password": "secret123",
		"api_key":  "abc",
		"token":    "jwt",
	})
	if out["reason"] != "spam" {
		t.Errorf("expected reason preserved, got %q", out["reason"])
	}
	if out["password"] != "***" || out["api_key"] != "***" || out["token"] != "***" {
		t.Errorf("expected sensitive fields redacted, got %v", out)
	}
}

func TestRecentClampsLargeN(t *testing.T) {
	l := NewLogger("")
	defer l.Close()

	for i := 0; i < 600; i++ {
		l.Log(ActionConfigChanged, "test", "key", map[string]string{"i": string(rune('0' + (i % 10)))})
	}

	recent := l.Recent(10000)
	if len(recent) != maxRecentLimit {
		t.Fatalf("expected clamp to %d, got %d", maxRecentLimit, len(recent))
	}
}

func TestRecentEmpty(t *testing.T) {
	l := NewLogger("")
	defer l.Close()

	recent := l.Recent(5)
	if recent != nil {
		t.Errorf("expected nil for empty logger, got %v", recent)
	}
}
