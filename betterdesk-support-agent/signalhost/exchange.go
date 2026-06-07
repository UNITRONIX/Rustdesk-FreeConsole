package signalhost

import (
	"crypto/rand"
	"fmt"

	pb "github.com/unitronix/betterdesk-server/proto"
	"golang.org/x/crypto/nacl/box"
	"google.golang.org/protobuf/proto"
)

type ephemeralKeyPair struct {
	public  [32]byte
	private [32]byte
}

func generateEphemeralKeyPair() (ephemeralKeyPair, error) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return ephemeralKeyPair{}, err
	}
	return ephemeralKeyPair{public: *pub, private: *priv}, nil
}

func buildSignedID(deviceID string, pub [32]byte) (*pb.Message, error) {
	idPk := &pb.IdPk{Id: deviceID, Pk: pub[:]}
	idPkBytes, err := proto.Marshal(idPk)
	if err != nil {
		return nil, err
	}
	signed := append(make([]byte, 64), idPkBytes...)
	return &pb.Message{
		Union: &pb.Message_SignedId{SignedId: &pb.SignedId{Id: signed}},
	}, nil
}

// openPublicKey decrypts the initiator's sealed symmetric key (responder role).
func openPublicKey(our ephemeralKeyPair, theirPK, sealed []byte) ([32]byte, error) {
	if len(theirPK) != 32 {
		return [32]byte{}, fmt.Errorf("invalid initiator public key length %d", len(theirPK))
	}
	if len(sealed) != 48 {
		return [32]byte{}, fmt.Errorf("invalid sealed key length %d", len(sealed))
	}
	var peerPub, priv [32]byte
	copy(peerPub[:], theirPK)
	priv = our.private
	var nonce [24]byte
	opened, ok := box.Open(nil, sealed, &nonce, &peerPub, &priv)
	if !ok {
		return [32]byte{}, fmt.Errorf("nacl box open failed")
	}
	if len(opened) != 32 {
		return [32]byte{}, fmt.Errorf("symmetric key wrong length %d", len(opened))
	}
	var sym [32]byte
	copy(sym[:], opened)
	return sym, nil
}
