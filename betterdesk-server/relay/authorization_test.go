package relay

import (
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
