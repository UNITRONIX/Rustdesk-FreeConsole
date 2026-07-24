package meshcentral

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

// RelayCookieData holds decrypted mesh relay authentication payload.
type RelayCookieData struct {
	UserID    string `json:"userid,omitempty"`
	RUserID   string `json:"ruserid,omitempty"`
	NodeID    string `json:"nodeid,omitempty"`
	Rights    uint32 `json:"r,omitempty"`
	GuestName string `json:"gn,omitempty"`
	ExpireMin int    `json:"expire,omitempty"`
	IssuedAt  int64  `json:"iat,omitempty"`
}

// CookieCodec encrypts relay auth cookies (AES-256-GCM).
type CookieCodec struct {
	key []byte
}

// NewCookieCodec derives a 32-byte key from the server secret.
func NewCookieCodec(secret string) (*CookieCodec, error) {
	if len(secret) < 16 {
		return nil, errors.New("mesh: cookie secret too short")
	}
	sum := sha512.Sum512([]byte(secret))
	return &CookieCodec{key: sum[0:32]}, nil
}

// Encode encrypts payload to a URL-safe cookie string.
func (c *CookieCodec) Encode(data *RelayCookieData, ttlMinutes int) (string, error) {
	if data.IssuedAt == 0 {
		data.IssuedAt = time.Now().Unix()
	}
	if data.ExpireMin == 0 && ttlMinutes > 0 {
		data.ExpireMin = ttlMinutes
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return "", err
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
	sealed := gcm.Seal(nonce, nonce, raw, nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Decode decrypts and validates a cookie.
func (c *CookieCodec) Decode(cookie string, maxTTLMinutes int) (*RelayCookieData, error) {
	sealed, err := base64.RawURLEncoding.DecodeString(cookie)
	if err != nil {
		// try standard base64 (MC uses binary in query sometimes)
		sealed, err = base64.StdEncoding.DecodeString(cookie)
		if err != nil {
			return nil, fmt.Errorf("mesh: cookie decode: %w", err)
		}
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("mesh: cookie too short")
	}
	nonce, payload := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	raw, err := gcm.Open(nil, nonce, payload, nil)
	if err != nil {
		return nil, fmt.Errorf("mesh: cookie open: %w", err)
	}
	var data RelayCookieData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	if data.IssuedAt > 0 && maxTTLMinutes > 0 {
		exp := data.IssuedAt + int64(data.ExpireMin*60)
		if data.ExpireMin == 0 {
			exp = data.IssuedAt + int64(maxTTLMinutes*60)
		}
		if time.Now().Unix() > exp {
			return nil, errors.New("mesh: cookie expired")
		}
	}
	return &data, nil
}
