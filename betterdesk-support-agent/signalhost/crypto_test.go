package signalhost

import (
	"crypto/rand"
	"testing"

	"golang.org/x/crypto/nacl/box"
)

func TestSecretBoxRoundTrip(t *testing.T) {
	var key [32]byte
	copy(key[:], []byte("01234567890123456789012345678901"))
	a := newSecretBoxStream(key)
	b := newSecretBoxStream(key)

	plain := []byte("RustDesk peer frame payload")
	ct, err := a.encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	out, err := b.decrypt(ct)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(plain) {
		t.Fatalf("round trip mismatch")
	}
}

func TestOpenPublicKeyRoundTrip(t *testing.T) {
	target, err := generateEphemeralKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	initPub, initPriv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	var sym [32]byte
	copy(sym[:], []byte("abcdefghijklmnopqrstuvwxyz123456"))

	var nonce [24]byte
	sealed := box.Seal(nil, sym[:], &nonce, &target.public, initPriv)

	theirPK := initPub[:]
	got, err := openPublicKey(target, theirPK, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got != sym {
		t.Fatalf("symmetric key mismatch")
	}
}

func TestHashPasswordDeterministic(t *testing.T) {
	a := hashPassword("secret", "salt", "challenge")
	b := hashPassword("secret", "salt", "challenge")
	if a != b {
		t.Fatal("hash not deterministic")
	}
}

func TestPeerHeaderLargeFrame(t *testing.T) {
	payload := make([]byte, 200*1024)
	hdr := encodePeerHeader(len(payload))
	if len(hdr) < 2 {
		t.Fatal("expected multi-byte header for 200KB")
	}
}
