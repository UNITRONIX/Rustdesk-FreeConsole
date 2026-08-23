package relay

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestAuthorizationRegistryAllowsExactlyOnePair(t *testing.T) {
	registry := NewAuthorizationRegistry()
	registry.now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	if !registry.Authorize("pair-uuid", "INIT01", "TARGET1") {
		t.Fatal("expected ticket authorization")
	}
	if !registry.Claim("pair-uuid") {
		t.Fatal("expected first authorized relay claim")
	}
	if !registry.Claim("pair-uuid") {
		t.Fatal("expected second authorized relay claim")
	}
	if registry.Claim("pair-uuid") {
		t.Fatal("third claim must be rejected after ticket consumption")
	}
	if registry.Authorize("pair-uuid", "INIT01", "TARGET1") {
		t.Fatal("consumed UUID must not be re-authorized before expiry")
	}
}

func TestAuthorizationRegistryRevokesPeerTickets(t *testing.T) {
	registry := NewAuthorizationRegistry()
	if !registry.Authorize("ban-uuid", "BANNED1", "TARGET1") {
		t.Fatal("expected ticket authorization")
	}

	registry.RevokeForPeer("BANNED1")
	if registry.Claim("ban-uuid") {
		t.Fatal("revoked peer ticket must not be claimable")
	}
}

func TestAuthorizationRegistryWaitsForLateAuthorization(t *testing.T) {
	registry := NewAuthorizationRegistry()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	result := make(chan bool, 1)
	go func() {
		result <- registry.WaitForAuthorization(ctx, "late-auth-uuid")
	}()

	time.Sleep(10 * time.Millisecond)
	if !registry.Authorize("late-auth-uuid", "INIT-LATE", "TARGET-LATE") {
		t.Fatal("expected late authorization to succeed")
	}

	select {
	case authorized := <-result:
		if !authorized {
			t.Fatal("waiter should be released by authorization")
		}
	case <-ctx.Done():
		t.Fatal("waiter was not released by authorization")
	}
}

func TestAuthorizationRegistryWaitTimeout(t *testing.T) {
	registry := NewAuthorizationRegistry()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	started := time.Now()
	if registry.WaitForAuthorization(ctx, "never-authorized-uuid") {
		t.Fatal("unknown UUID must not become authorized")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("wait timeout took too long: %v", elapsed)
	}
}

func TestAuthorizationRegistryRevokeWakesWaiter(t *testing.T) {
	registry := NewAuthorizationRegistry()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	const relayUUID = "revoke-wait-uuid"
	result := make(chan bool, 1)
	go func() {
		result <- registry.WaitForAuthorization(ctx, relayUUID)
	}()

	deadline := time.Now().Add(time.Second)
	for {
		registry.mu.Lock()
		_, registered := registry.waiters[relayUUID]
		registry.mu.Unlock()
		if registered {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiter did not register")
		}
		time.Sleep(time.Millisecond)
	}

	registry.mu.Lock()
	registry.tickets[relayUUID] = &relayAuthorization{
		initiatorID: "BANNED-WAITER",
		targetID:    "TARGET-WAITER",
		expiresAt:   time.Now().Add(time.Minute),
	}
	registry.mu.Unlock()
	registry.RevokeForPeer("BANNED-WAITER")

	select {
	case authorized := <-result:
		if authorized {
			t.Fatal("revoked waiter must not become authorized")
		}
	case <-ctx.Done():
		t.Fatal("revoke did not wake waiter")
	}
}

func TestAuthorizationRegistryClaimsAreAtomic(t *testing.T) {
	registry := NewAuthorizationRegistry()
	const relayUUID = "concurrent-claims-uuid"
	if !registry.Authorize(relayUUID, "INIT-CONCURRENT", "TARGET-CONCURRENT") {
		t.Fatal("expected ticket authorization")
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	claims := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if registry.Claim(relayUUID) {
				mu.Lock()
				claims++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claims != 2 {
		t.Fatalf("successful claims = %d, want exactly 2", claims)
	}
}

func TestRelayAuthWaitLimiterEnforcesGlobalAndPerIPLimits(t *testing.T) {
	limiter := newRelayAuthWaitLimiter(2, 1)
	if !limiter.acquire("198.51.100.10") {
		t.Fatal("first slot should be available")
	}
	if limiter.acquire("198.51.100.10") {
		t.Fatal("per-IP limit should reject the second slot")
	}
	if !limiter.acquire("198.51.100.11") {
		t.Fatal("second IP should use the remaining global slot")
	}
	if limiter.acquire("198.51.100.12") {
		t.Fatal("global limit should reject the third slot")
	}

	limiter.release("198.51.100.10")
	if !limiter.acquire("198.51.100.12") {
		t.Fatal("released slot should be reusable")
	}
	total, ips := limiter.snapshot()
	if total != 2 || ips != 2 {
		t.Fatalf("limiter snapshot = total %d, IPs %d; want 2, 2", total, ips)
	}
}
