// Package brandprofile provides authenticated branding envelopes for the
// Support Agent. It deliberately uses a signing key rather than a symmetric
// key derived from data stored alongside the profile.
package brandprofile

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
)

var magic = []byte("BDBP2\x00")

const signatureSize = ed25519.SignatureSize

// Sign returns a versioned envelope containing an Ed25519 signature and the
// original JSON profile. The public key is intentionally not part of the
// envelope: callers embed it in the authenticated application artifact.
func Sign(profile []byte, privateKey ed25519.PrivateKey) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid Ed25519 private key length")
	}
	if len(profile) == 0 {
		return nil, fmt.Errorf("empty branding profile")
	}
	signature := ed25519.Sign(privateKey, profile)
	out := make([]byte, 0, len(magic)+signatureSize+len(profile))
	out = append(out, magic...)
	out = append(out, signature...)
	out = append(out, profile...)
	return out, nil
}

// Verify validates an authenticated profile envelope and returns its original
// JSON. It rejects unsigned, truncated, and tampered data.
func Verify(envelope []byte, publicKey ed25519.PublicKey) ([]byte, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid Ed25519 public key length")
	}
	if !IsSigned(envelope) {
		return nil, fmt.Errorf("not a signed branding profile")
	}
	offset := len(magic)
	if len(envelope) <= offset+signatureSize {
		return nil, fmt.Errorf("truncated branding profile")
	}
	signature := envelope[offset : offset+signatureSize]
	profile := envelope[offset+signatureSize:]
	if !ed25519.Verify(publicKey, profile, signature) {
		return nil, fmt.Errorf("branding profile signature verification failed")
	}
	return profile, nil
}

// IsSigned reports whether the blob uses the signed-profile envelope format.
func IsSigned(blob []byte) bool {
	if len(blob) < len(magic) {
		return false
	}
	return subtle.ConstantTimeCompare(blob[:len(magic)], magic) == 1
}

// EncodePublicKey produces the compact base64 value used in the generated
// public-key resource.
func EncodePublicKey(key ed25519.PublicKey) (string, error) {
	if len(key) != ed25519.PublicKeySize {
		return "", fmt.Errorf("invalid Ed25519 public key length")
	}
	return base64.RawStdEncoding.EncodeToString(key), nil
}

// DecodePublicKey parses the compact public-key resource.
func DecodePublicKey(encoded string) (ed25519.PublicKey, error) {
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode branding public key: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid Ed25519 public key length")
	}
	return ed25519.PublicKey(raw), nil
}
