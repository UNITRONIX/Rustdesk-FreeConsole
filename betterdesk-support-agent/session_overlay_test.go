package main

import "testing"

func TestSessionOverlayDisconnectInvokesTerminationCallback(t *testing.T) {
	calls := 0
	overlay := &sessionOverlay{
		onDisconnect: func() {
			calls++
		},
	}

	overlay.requestDisconnect()
	if calls != 1 {
		t.Fatalf("disconnect callback calls = %d, want 1", calls)
	}
}
