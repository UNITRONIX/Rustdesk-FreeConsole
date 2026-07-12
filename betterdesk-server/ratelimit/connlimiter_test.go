package ratelimit

import (
	"sync"
	"testing"
)

func TestConnLimiterBasic(t *testing.T) {
	l := NewConnLimiter(3)

	if !l.Acquire("1.2.3.4") {
		t.Error("First acquire should succeed")
	}
	if !l.Acquire("1.2.3.4") {
		t.Error("Second acquire should succeed")
	}
	if !l.Acquire("1.2.3.4") {
		t.Error("Third acquire should succeed")
	}
	if l.Acquire("1.2.3.4") {
		t.Error("Fourth acquire should fail (limit=3)")
	}

	if l.ActiveCount("1.2.3.4") != 3 {
		t.Errorf("Expected 3 active, got %d", l.ActiveCount("1.2.3.4"))
	}

	l.Release("1.2.3.4")
	if !l.Acquire("1.2.3.4") {
		t.Error("After release, acquire should succeed")
	}
}

func TestConnLimiterDifferentIPs(t *testing.T) {
	l := NewConnLimiter(2)

	l.Acquire("1.1.1.1")
	l.Acquire("1.1.1.1")
	l.Acquire("2.2.2.2")

	if l.Acquire("1.1.1.1") {
		t.Error("1.1.1.1 should be at limit")
	}
	if !l.Acquire("2.2.2.2") {
		t.Error("2.2.2.2 should still have room")
	}

	if l.TotalActive() != 4 {
		t.Errorf("Expected 4 total, got %d", l.TotalActive())
	}
}

func TestConnLimiterRelease(t *testing.T) {
	l := NewConnLimiter(1)
	l.Acquire("1.1.1.1")
	l.Release("1.1.1.1")

	if l.ActiveCount("1.1.1.1") != 0 {
		t.Error("After release, count should be 0")
	}
	if l.TotalActive() != 0 {
		t.Error("Total should be 0 after all released")
	}
}

func TestConnLimiterFromIntClamps(t *testing.T) {
	l := NewConnLimiterFromInt(1<<31 + 1000)
	if l.maxConn != 1<<31-1 {
		t.Errorf("Expected clamped maxConn %d, got %d", 1<<31-1, l.maxConn)
	}
	if !l.Acquire("1.1.1.1") {
		t.Error("Acquire should succeed after clamp")
	}
}

func TestConnLimiterConcurrent(t *testing.T) {
	l := NewConnLimiter(100)
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.Acquire("10.0.0.1")
		}()
	}
	wg.Wait()

	// At most 100 should have been acquired
	if l.ActiveCount("10.0.0.1") != 100 {
		t.Errorf("Expected 100 active, got %d", l.ActiveCount("10.0.0.1"))
	}
}
