package totp

import (
	"testing"
	"time"
)

func TestValidateRFC6238SHA1SixDigitProfile(t *testing.T) {
	// RFC 6238 Appendix B: SHA-1 secret at T=59 produces 94287082. The
	// BetterDesk Support Agent uses its last six digits, 287082.
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	at := time.Unix(59, 0)
	if !Validate(secret, "287082", at) {
		t.Fatal("valid RFC 6238 code was rejected")
	}
	if Validate(secret, "287083", at) {
		t.Fatal("invalid code was accepted")
	}
}
