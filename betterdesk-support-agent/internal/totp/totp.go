// Package totp implements the small RFC 6238 verifier needed by the Support
// Agent. It intentionally has no dependency on BetterDesk server packages.
package totp

import (
	"crypto/hmac"
	"crypto/sha1" // RFC 6238's required SHA-1 interoperability profile.
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

const (
	digits = 6
	period = 30 * time.Second
)

// Validate accepts a six-digit TOTP code in the current 30-second window,
// with one adjacent window tolerated for normal clock drift.
func Validate(secret, code string, now time.Time) bool {
	if len(code) != digits {
		return false
	}
	for offset := -1; offset <= 1; offset++ {
		expected, err := codeAt(secret, now.Add(time.Duration(offset)*period))
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func codeAt(secret string, at time.Time) (string, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return "", err
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/int64(period/time.Second)))
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := int(sum[len(sum)-1] & 0x0f)
	if offset+4 > len(sum) {
		return "", fmt.Errorf("invalid TOTP digest")
	}
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000), nil
}

func decodeSecret(secret string) ([]byte, error) {
	normalized := strings.TrimRight(strings.ToUpper(strings.TrimSpace(secret)), "=")
	if normalized == "" {
		return nil, fmt.Errorf("empty TOTP secret")
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalized)
}
