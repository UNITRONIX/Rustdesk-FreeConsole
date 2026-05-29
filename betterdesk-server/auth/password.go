// Package auth provides authentication primitives for the BetterDesk server:
// password hashing (PBKDF2-HMAC-SHA256), JWT tokens (HS256), and TOTP 2FA (RFC 6238).
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/pbkdf2"
)

const (
	// currentIterations is the cost factor for newly created hashes.
	// 600_000 matches the OWASP 2023 recommendation for PBKDF2-HMAC-SHA256.
	// Increase periodically as compute power rises.
	currentIterations = 600_000

	// legacyIterations is used to verify hashes produced by the older single-block
	// custom PBKDF2 implementation. Hashes in the legacy "hex(salt):hex(hash)" form
	// are still accepted by VerifyPassword and should be re-hashed on next successful
	// login (see NeedsRehash).
	legacyIterations = 100_000

	saltLength = 16
	keyLength  = 32 // SHA-256 output size

	// hashScheme is the prefix for the modern, self-describing hash format:
	//   pbkdf2-sha256$<iterations>$<hex-salt>$<hex-hash>
	hashScheme = "pbkdf2-sha256"
)

// HashPassword creates a salted PBKDF2-HMAC-SHA256 hash of the password using
// the current cost parameters. The returned string is self-describing:
//
//	pbkdf2-sha256$<iterations>$<hex-salt>$<hex-hash>
//
// VerifyPassword also accepts hashes in the legacy "hex(salt):hex(hash)" form
// (100_000 iterations) for backwards compatibility with existing user records.
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: generate salt: %w", err)
	}
	hash := pbkdf2.Key([]byte(password), salt, currentIterations, keyLength, sha256.New)
	return fmt.Sprintf("%s$%d$%s$%s",
		hashScheme,
		currentIterations,
		hex.EncodeToString(salt),
		hex.EncodeToString(hash),
	), nil
}

// VerifyPassword checks a password against a stored hash. Supports three formats:
//
//  1. Modern: "pbkdf2-sha256$<iterations>$<hex-salt>$<hex-hash>"
//  2. Bcrypt: "$2a$", "$2b$", "$2y$" (Node.js bcrypt compatibility)
//  3. Legacy: "hex(salt):hex(hash)" — assumed 100_000 iterations
//
// Uses constant-time comparison to prevent timing attacks.
func VerifyPassword(stored, password string) bool {
	if strings.HasPrefix(stored, hashScheme+"$") {
		return verifyModern(stored, password)
	}
	if strings.HasPrefix(stored, "$2a$") || strings.HasPrefix(stored, "$2b$") || strings.HasPrefix(stored, "$2y$") {
		return bcrypt.CompareHashAndPassword([]byte(stored), []byte(password)) == nil
	}
	return verifyLegacy(stored, password)
}

// NeedsRehash reports whether the stored hash uses outdated parameters (legacy
// format, bcrypt format, or fewer iterations than the current cost). Callers
// should re-hash the password on next successful login when this returns true.
func NeedsRehash(stored string) bool {
	if strings.HasPrefix(stored, "$2a$") || strings.HasPrefix(stored, "$2b$") || strings.HasPrefix(stored, "$2y$") {
		return true // bcrypt hashes should be migrated to PBKDF2
	}
	if !strings.HasPrefix(stored, hashScheme+"$") {
		return true
	}
	parts := strings.SplitN(stored, "$", 4)
	if len(parts) != 4 {
		return true
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil {
		return true
	}
	return iter < currentIterations
}

func verifyModern(stored, password string) bool {
	parts := strings.SplitN(stored, "$", 4)
	if len(parts) != 4 {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 || iter > 10_000_000 {
		return false
	}
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[3])
	if err != nil || len(expected) == 0 {
		return false
	}
	actual := pbkdf2.Key([]byte(password), salt, iter, len(expected), sha256.New)
	return subtle.ConstantTimeCompare(expected, actual) == 1
}

func verifyLegacy(stored, password string) bool {
	parts := strings.SplitN(stored, ":", 2)
	if len(parts) != 2 {
		return false
	}
	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[1])
	if err != nil || len(expected) == 0 {
		return false
	}
	actual := pbkdf2.Key([]byte(password), salt, legacyIterations, len(expected), sha256.New)
	return subtle.ConstantTimeCompare(expected, actual) == 1
}

// GenerateRandomString generates a URL-safe random string of n bytes (hex-encoded).
func GenerateRandomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
