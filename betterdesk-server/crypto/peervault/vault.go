// Package peervault encrypts recoverable org peer passwords at rest (AES-256-GCM).
// Used for centrally managed unattended presets (#367). Never log plaintext.
package peervault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

const KeyIDV1 = "v1"

// Vault seals/opens peer credential plaintext with a server-side key.
type Vault struct {
	key   []byte
	keyID string
}

// New derives a 32-byte AES key from secret (SHA-512, first 32 bytes).
func New(secret string) (*Vault, error) {
	if len(secret) < 16 {
		return nil, errors.New("peervault: secret too short (min 16)")
	}
	sum := sha512.Sum512([]byte(secret))
	return &Vault{key: sum[0:32], keyID: KeyIDV1}, nil
}

// Seal encrypts plaintext; returns base64 nonce and ciphertext (separate columns).
func (v *Vault) Seal(plaintext string) (nonceB64, cipherB64, keyID string, err error) {
	if v == nil || len(v.key) == 0 {
		return "", "", "", errors.New("peervault: nil vault")
	}
	block, err := aes.NewCipher(v.key)
	if err != nil {
		return "", "", "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", "", "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return base64.RawURLEncoding.EncodeToString(nonce),
		base64.RawURLEncoding.EncodeToString(sealed),
		v.keyID,
		nil
}

// Open decrypts a row stored by Seal.
func (v *Vault) Open(nonceB64, cipherB64, keyID string) (string, error) {
	if v == nil || len(v.key) == 0 {
		return "", errors.New("peervault: nil vault")
	}
	if keyID != "" && keyID != v.keyID {
		return "", fmt.Errorf("peervault: unsupported key id %q", keyID)
	}
	nonce, err := base64.RawURLEncoding.DecodeString(nonceB64)
	if err != nil {
		return "", fmt.Errorf("peervault: nonce: %w", err)
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(cipherB64)
	if err != nil {
		return "", fmt.Errorf("peervault: ciphertext: %w", err)
	}
	block, err := aes.NewCipher(v.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(nonce) != gcm.NonceSize() {
		return "", errors.New("peervault: bad nonce size")
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("peervault: open: %w", err)
	}
	return string(plain), nil
}
