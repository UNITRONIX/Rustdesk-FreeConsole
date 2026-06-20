package signal

import (
	"encoding/hex"
	"testing"
)

func TestPeerUUIDFromDB(t *testing.T) {
	const hexUUID = "fe81664074fd4162aede9234abae6a78"
	got := peerUUIDFromDB(hexUUID)
	if len(got) != 16 {
		t.Fatalf("len = %d, want 16", len(got))
	}
	if hex.EncodeToString(got) != hexUUID {
		t.Fatalf("decoded = %x", got)
	}
}

func TestPeerUUIDEqualBinaryVsASCIIHexBug(t *testing.T) {
	const hexUUID = "fe81664074fd4162aede9234abae6a78"
	binary := peerUUIDFromDB(hexUUID)
	asciiBug := []byte(hexUUID) // old []byte(dbPeer.UUID) behaviour
	if !peerUUIDEqual(binary, asciiBug) {
		t.Fatal("expected binary UUID to match legacy ASCII-loaded form")
	}
}
