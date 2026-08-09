package brandprofile

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestSignedProfileRoundTrip(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	profile := []byte(`{"bundle_id":"bundle-1","server":{"address":"https://desk.example"}}`)
	envelope, err := Sign(profile, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if !IsSigned(envelope) {
		t.Fatal("expected signed envelope")
	}
	got, err := Verify(envelope, publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(profile) {
		t.Fatalf("profile mismatch: got %q want %q", got, profile)
	}
}

func TestSignedProfileRejectsTamperingAndWrongKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := Sign([]byte(`{"bundle_id":"bundle-1"}`), privateKey)
	if err != nil {
		t.Fatal(err)
	}
	envelope[len(envelope)-1] ^= 1
	if _, err := Verify(envelope, publicKey); err == nil {
		t.Fatal("expected tampering rejection")
	}

	otherPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	clean, err := Sign([]byte(`{"bundle_id":"bundle-1"}`), privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(clean, otherPublic); err == nil {
		t.Fatal("expected wrong-key rejection")
	}
}

func TestPublicKeyEncoding(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodePublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodePublicKey(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !publicKey.Equal(decoded) {
		t.Fatal("public key did not round-trip")
	}
}
