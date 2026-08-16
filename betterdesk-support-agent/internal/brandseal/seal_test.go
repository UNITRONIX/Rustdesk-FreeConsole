package brandseal

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestSealRoundTrip(t *testing.T) {
	plain := []byte(`{"server_key":"secret","server":{"address":"https://x"}}`)
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		t.Fatal(err)
	}
	blob, err := Seal(plain, salt)
	if err != nil {
		t.Fatal(err)
	}
	if !IsSealed(blob) {
		t.Fatal("expected sealed magic")
	}
	out, err := Unseal(blob)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, plain) {
		t.Fatalf("mismatch %q vs %q", out, plain)
	}
}

func TestSealTamperFails(t *testing.T) {
	plain := []byte(`{"a":1}`)
	salt := make([]byte, 32)
	_, _ = rand.Read(salt)
	blob, err := Seal(plain, salt)
	if err != nil {
		t.Fatal(err)
	}
	blob[len(blob)-1] ^= 0x55
	if _, err := Unseal(blob); err == nil {
		t.Fatal("expected auth failure")
	}
}
