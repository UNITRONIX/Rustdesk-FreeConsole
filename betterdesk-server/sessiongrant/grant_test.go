package sessiongrant

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"
)

func testSigner(t *testing.T, now time.Time) *Signer {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	signer.now = func() time.Time { return now }
	return signer
}

func validClaims(now time.Time) Claims {
	return Claims{
		DeviceID:     "BD-12345",
		OperatorID:   "operator-1",
		SessionID:    "session-1",
		Transport:    "relay",
		Initiator:    "operator",
		Capabilities: []string{"desktop", "clipboard", "desktop"},
		ExpiresAt:    now.Add(5 * time.Minute).Unix(),
		Nonce:        "nonce-1",
	}
}

func TestIssueAndVerifyBoundSessionGrant(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	signer := testSigner(t, now)
	token, err := signer.Issue(validClaims(now))
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Verify(token, signer.PublicKey(), "BD-12345", "relay", now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Audience != audience || claims.IssuedAt != now.Unix() {
		t.Fatalf("unexpected normalized claims: %+v", claims)
	}
	if len(claims.Capabilities) != 2 || claims.Capabilities[0] != "clipboard" || claims.Capabilities[1] != "desktop" {
		t.Fatalf("capabilities were not canonicalized: %#v", claims.Capabilities)
	}
}

func TestVerifyRejectsTamperingWrongTargetAndExpiredGrants(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	signer := testSigner(t, now)
	token, err := signer.Issue(validClaims(now))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := Verify(token, signer.PublicKey(), "BD-other", "relay", now); err == nil {
		t.Fatal("expected device-binding rejection")
	}
	if _, err := Verify(token, signer.PublicKey(), "BD-12345", "cdap", now); err == nil {
		t.Fatal("expected transport-binding rejection")
	}
	parts := strings.Split(token, ".")
	replacement := byte('A')
	if parts[1][0] == replacement {
		replacement = 'B'
	}
	parts[1] = string(replacement) + parts[1][1:]
	tampered := strings.Join(parts, ".")
	if _, err := Verify(tampered, signer.PublicKey(), "BD-12345", "relay", now); err == nil {
		t.Fatal("expected signature rejection")
	}
	if _, err := Verify(token, signer.PublicKey(), "BD-12345", "relay", now.Add(6*time.Minute)); err == nil {
		t.Fatal("expected expiration rejection")
	}
}

func TestIssueRejectsOverlyBroadOrMissingGrant(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	signer := testSigner(t, now)
	claims := validClaims(now)
	claims.ExpiresAt = now.Add(maxTTL + time.Second).Unix()
	if _, err := signer.Issue(claims); err == nil {
		t.Fatal("expected long lifetime rejection")
	}
	claims = validClaims(now)
	claims.Capabilities = nil
	if _, err := signer.Issue(claims); err == nil {
		t.Fatal("expected empty-capability rejection")
	}
	claims = validClaims(now)
	claims.Initiator = "support_agent"
	if _, err := signer.Issue(claims); err == nil {
		t.Fatal("expected outbound-initiator rejection")
	}
}
