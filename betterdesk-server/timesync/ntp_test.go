package timesync

import (
	"testing"
	"time"
)

func TestNtpTimestampToTime(t *testing.T) {
	// 2024-01-01 00:00:00 UTC ≈ NTP seconds since 1900
	b := make([]byte, 8)
	secs := uint32(1704067200 + ntpEpochOffset)
	b[0] = byte(secs >> 24)
	b[1] = byte(secs >> 16)
	b[2] = byte(secs >> 8)
	b[3] = byte(secs)
	got := ntpTimestampToTime(b)
	if got.IsZero() {
		t.Fatal("expected non-zero time")
	}
	if got.UTC().Year() != 2024 {
		t.Fatalf("year = %d", got.UTC().Year())
	}
}

func TestQueryNTPInvalidServer(t *testing.T) {
	_, _, err := QueryNTP("127.0.0.1:1", 200*time.Millisecond)
	if err == nil {
		t.Fatal("expected error for unreachable NTP")
	}
}
