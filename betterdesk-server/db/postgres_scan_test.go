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
