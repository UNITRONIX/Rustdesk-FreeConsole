package peervault

import "testing"

func TestSealOpenRoundTrip(t *testing.T) {
	v, err := New("test-secret-at-least-16b")
	if err != nil {
		t.Fatal(err)
	}
	n, c, kid, err := v.Seal("peer-password-xyz")
	if err != nil {
		t.Fatal(err)
	}
	if kid != KeyIDV1 {
		t.Fatalf("key id: %s", kid)
	}
	out, err := v.Open(n, c, kid)
	if err != nil {
		t.Fatal(err)
	}
	if out != "peer-password-xyz" {
		t.Fatalf("got %q", out)
	}
}

func TestNewRejectsShortSecret(t *testing.T) {
	if _, err := New("short"); err == nil {
		t.Fatal("expected error")
	}
}

func TestTamperFails(t *testing.T) {
	v, err := New("test-secret-at-least-16b")
	if err != nil {
		t.Fatal(err)
	}
	n, c, kid, err := v.Seal("secret")
	if err != nil {
		t.Fatal(err)
	}
	c = c[:len(c)-1] + "x"
	if _, err := v.Open(n, c, kid); err == nil {
		t.Fatal("expected open failure")
	}
}
