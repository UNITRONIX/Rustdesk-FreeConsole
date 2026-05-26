package auth

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// recoveryCodeCount is the number of recovery codes generated per TOTP enrollment.
const recoveryCodeCount = 10

// recoveryCodeAlphabet uses unambiguous characters (no 0/O, 1/I/L).
const recoveryCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// GenerateRecoveryCodes returns a slice of N freshly-generated, human-readable
// recovery codes in the form "XXXX-XXXX-XX" (10 chars, 5.1e14 combinations).
// The plaintext codes are returned ONCE — caller must show them to the user
// immediately and persist only the hashes via HashRecoveryCodes.
func GenerateRecoveryCodes() ([]string, error) {
	codes := make([]string, recoveryCodeCount)
	alpha := []byte(recoveryCodeAlphabet)
	for i := 0; i < recoveryCodeCount; i++ {
		raw := make([]byte, 10)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		var b strings.Builder
		for j, c := range raw {
			b.WriteByte(alpha[int(c)%len(alpha)])
			if j == 3 || j == 7 {
				b.WriteByte('-')
			}
		}
		codes[i] = b.String()
	}
	return codes, nil
}

// HashRecoveryCodes returns a JSON-encoded array of bcrypt hashes suitable for
// storage in the users.totp_recovery_codes column. Use a moderate cost (10) —
// codes are short and high-entropy; we trade some CPU for verify latency.
func HashRecoveryCodes(plain []string) (string, error) {
	hashes := make([]string, 0, len(plain))
	for _, code := range plain {
		h, err := bcrypt.GenerateFromPassword([]byte(normalizeRecoveryCode(code)), 10)
		if err != nil {
			return "", err
		}
		hashes = append(hashes, string(h))
	}
	b, err := json.Marshal(hashes)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ConsumeRecoveryCode validates `code` against the stored JSON-encoded hash list
// and, on match, returns the updated JSON list with the consumed hash removed.
// The caller MUST persist the returned string back to the database to make the
// code single-use.
//
// Returns: (newStored string, matched bool, err error).
func ConsumeRecoveryCode(stored, code string) (string, bool, error) {
	stored = strings.TrimSpace(stored)
	if stored == "" {
		return stored, false, nil
	}
	var hashes []string
	if err := json.Unmarshal([]byte(stored), &hashes); err != nil {
		return stored, false, errors.New("auth: malformed recovery code store")
	}
	normalized := normalizeRecoveryCode(code)
	if normalized == "" {
		return stored, false, nil
	}
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(normalized)) == nil {
			// Remove matched hash.
			hashes = append(hashes[:i], hashes[i+1:]...)
			b, err := json.Marshal(hashes)
			if err != nil {
				return stored, true, err
			}
			return string(b), true, nil
		}
	}
	return stored, false, nil
}

// normalizeRecoveryCode strips whitespace and dashes and uppercases for matching.
func normalizeRecoveryCode(code string) string {
	var b strings.Builder
	for _, r := range code {
		if r == '-' || r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		if r >= 'a' && r <= 'z' {
			r -= 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}
