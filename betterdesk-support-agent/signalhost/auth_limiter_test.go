package signalhost

import (
	"testing"
	"time"
)

func TestAuthenticationLimiterLocksRepeatedFailuresWithoutSecrets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	limiter := newAuthenticationLimiter(func() time.Time { return now })

	for i := 0; i < maxAuthFailures-1; i++ {
		if !limiter.allow("operator-1") {
			t.Fatalf("attempt %d was blocked before the threshold", i+1)
		}
		limiter.failure("operator-1")
	}
	if !limiter.allow("operator-1") {
		t.Fatal("last allowed attempt was blocked before recording its failure")
	}
	limiter.failure("operator-1")
	if limiter.allow("operator-1") {
		t.Fatal("repeated failed authentication did not lock the operator")
	}
	if !limiter.allow("another-operator") {
		t.Fatal("one operator's lockout affected another operator")
	}

	now = now.Add(authLockoutPeriod)
	if !limiter.allow("operator-1") {
		t.Fatal("operator remained locked after the lockout period")
	}
}

func TestAuthenticationLimiterSuccessClearsFailureHistory(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	limiter := newAuthenticationLimiter(func() time.Time { return now })

	for i := 0; i < maxAuthFailures-1; i++ {
		limiter.failure("operator-1")
	}
	limiter.success("operator-1")
	for i := 0; i < maxAuthFailures-1; i++ {
		limiter.failure("operator-1")
	}
	if !limiter.allow("operator-1") {
		t.Fatal("a successful authentication did not reset failures")
	}
}

func TestAuthenticationAttemptKeyIsBounded(t *testing.T) {
	long := make([]byte, 256)
	for i := range long {
		long[i] = 'a'
	}
	if got := len(authenticationAttemptKey(string(long))); got != 128 {
		t.Fatalf("key length = %d, want 128", got)
	}
	if got := authenticationAttemptKey(" \t "); got != "anonymous" {
		t.Fatalf("blank key = %q, want anonymous", got)
	}
}
