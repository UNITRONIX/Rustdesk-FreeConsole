package crypto

import "testing"

func TestAccessSecretRoundTrip(t *testing.T) {
	c, err := NewAccessSecretCodec("test-secret-key-32chars-minimum!")
	if err != nil {
		t.Fatal(err)
	}
	enc, err := c.Encrypt("peer-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if enc == "" || enc == "peer-password-123" {
		t.Fatalf("expected opaque ciphertext, got %q", enc)
	}
	plain, err := c.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "peer-password-123" {
		t.Fatalf("got %q", plain)
	}
	empty, err := c.Encrypt("")
	if err != nil || empty != "" {
		t.Fatalf("empty encrypt: %q %v", empty, err)
	}
}
