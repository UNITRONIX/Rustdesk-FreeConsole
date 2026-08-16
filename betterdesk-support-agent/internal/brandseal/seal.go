package brandseal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
)

var Magic = []byte("BDBR1\x00")

func Seal(plaintext, salt []byte) ([]byte, error) {
	if len(salt) < 16 {
		return nil, fmt.Errorf("salt too short")
	}
	key := sha256.Sum256(append([]byte("betterdesk-branding-seal-v1|"), salt...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, nonce, plaintext, Magic)

	out := make([]byte, 0, len(Magic)+4+len(salt)+len(nonce)+len(sealed))
	out = append(out, Magic...)
	var slen [4]byte
	binary.BigEndian.PutUint32(slen[:], uint32(len(salt)))
	out = append(out, slen[:]...)
	out = append(out, salt...)
	out = append(out, nonce...)
	out = append(out, sealed...)
	return out, nil
}

func Unseal(blob []byte) ([]byte, error) {
	if !IsSealed(blob) {
		return nil, fmt.Errorf("not a sealed branding blob")
	}
	off := len(Magic)
	slen := int(binary.BigEndian.Uint32(blob[off : off+4]))
	off += 4
	if slen < 16 || off+slen > len(blob) {
		return nil, fmt.Errorf("invalid salt length")
	}
	salt := blob[off : off+slen]
	off += slen

	key := sha256.Sum256(append([]byte("betterdesk-branding-seal-v1|"), salt...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if off+ns > len(blob) {
		return nil, fmt.Errorf("truncated nonce")
	}
	nonce := blob[off : off+ns]
	ciphertext := blob[off+ns:]
	return gcm.Open(nil, nonce, ciphertext, Magic)
}

func IsSealed(blob []byte) bool {
	return len(blob) >= len(Magic) && string(blob[:len(Magic)]) == string(Magic)
}
