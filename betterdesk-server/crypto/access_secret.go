package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// AccessSecretCodec encrypts reversible access-policy passwords (AES-256-GCM).
// Used so operators can auto-authenticate when unattended access is enabled.
type AccessSecretCodec struct {
	key []byte
}

// NewAccessSecretCodec derives a 32-byte key from the server JWT/admin secret.
func NewAccessSecretCodec(secret string) (*AccessSecretCodec, error) {
	if len(secret) < 16 {
		return nil, errors.New("access secret key too short (need >= 16 chars)")
	}
	sum := sha256.Sum256([]byte("betterdesk-access-policy-v1:" + secret))
	return &AccessSecretCodec{key: sum[:]}, nil
}

// Encrypt returns a base64url ciphertext (nonce || sealed).
func (c *AccessSecretCodec) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt. Empty ciphertext yields empty plaintext.
func (c *AccessSecretCodec) Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("access secret decode: %w", err)
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(raw) < ns {
		return "", errors.New("access secret ciphertext too short")
	}
	plain, err := gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", fmt.Errorf("access secret decrypt: %w", err)
	}
	return string(plain), nil
}
