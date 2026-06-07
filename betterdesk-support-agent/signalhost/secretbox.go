package signalhost

import (
	"encoding/binary"
	"fmt"

	"golang.org/x/crypto/nacl/secretbox"
)

// secretBoxStream implements RustDesk counter-based XSalsa20-Poly1305 framing.
type secretBoxStream struct {
	key    [32]byte
	sendSeq uint64
	recvSeq uint64
}

func newSecretBoxStream(key [32]byte) *secretBoxStream {
	return &secretBoxStream{key: key}
}

func (s *secretBoxStream) encrypt(plaintext []byte) ([]byte, error) {
	s.sendSeq++
	var nonce [24]byte
	binary.LittleEndian.PutUint64(nonce[:8], s.sendSeq)
	return secretbox.Seal(nil, plaintext, &nonce, &s.key), nil
}

func (s *secretBoxStream) decrypt(ciphertext []byte) ([]byte, error) {
	s.recvSeq++
	var nonce [24]byte
	binary.LittleEndian.PutUint64(nonce[:8], s.recvSeq)
	plain, ok := secretbox.Open(nil, ciphertext, &nonce, &s.key)
	if !ok {
		return nil, fmt.Errorf("secretbox decrypt failed (seq=%d)", s.recvSeq)
	}
	return plain, nil
}
