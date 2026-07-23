package db

import (
	"strings"
	"testing"
)

// Issue #301 / #292: Postgres ListUsers/GetUser* must COALESCE totp_secret so
// NULL values from Node panel inserts do not break scanning into Go string.
func TestUserSelectColsPGCoalesceTotpSecret(t *testing.T) {
	if !strings.Contains(userSelectColsPG, "COALESCE(totp_secret, '')") {
		t.Fatalf("userSelectColsPG missing totp_secret COALESCE (issue #301): %q", userSelectColsPG)
	}
}

// Issue #300: CreateClientSession RETURNING must cast TIMESTAMPTZ to text;
// scanning raw created_at into *string fails with OID 1184.
func TestCreateClientSessionReturningFormatsCreatedAt(t *testing.T) {
	want := "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
	if !strings.Contains(createClientSessionReturning, want) {
		t.Fatalf("createClientSessionReturning missing to_char for created_at (issue #300): %q", createClientSessionReturning)
	}
	if strings.Contains(createClientSessionReturning, "created_at") &&
		!strings.Contains(createClientSessionReturning, "to_char") {
		t.Fatalf("createClientSessionReturning must not return raw created_at: %q", createClientSessionReturning)
	}
}
