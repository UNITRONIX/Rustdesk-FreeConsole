package signalhost

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func TestBuildSignedIDUsesHostIdentitySignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var ephemeral [32]byte
	if _, err := rand.Read(ephemeral[:]); err != nil {
		t.Fatal(err)
	}
	message, err := buildSignedID("BD-12345", ephemeral, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	signed := message.GetSignedId().GetId()
	if len(signed) <= ed25519.SignatureSize {
		t.Fatalf("signed id length = %d", len(signed))
	}
	signature := signed[:ed25519.SignatureSize]
	payload := signed[ed25519.SignatureSize:]
	if !ed25519.Verify(publicKey, payload, signature) {
		t.Fatal("SignedId did not verify with the registered identity")
	}
	var idPK pb.IdPk
	if err := proto.Unmarshal(payload, &idPK); err != nil {
		t.Fatal(err)
	}
	if idPK.GetId() != "BD-12345" || string(idPK.GetPk()) != string(ephemeral[:]) {
		t.Fatalf("unexpected signed IdPk: id=%q public_key_len=%d", idPK.GetId(), len(idPK.GetPk()))
	}
}

func TestBuildSignedIDRejectsMissingIdentity(t *testing.T) {
	if _, err := buildSignedID("BD-12345", [32]byte{}, nil); err == nil {
		t.Fatal("expected missing identity rejection")
	}
}
