// Package crypto — Ed25519 key pair management for the BetterDesk server.
// Generates, loads, saves, and uses Ed25519 keys for signing IdPk messages.
// Compatible with RustDesk client key verification.
package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"

	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

// KeyPair holds an Ed25519 key pair for the server.
type KeyPair struct {
	PrivateKey ed25519.PrivateKey // 64 bytes: 32 seed + 32 public
	PublicKey  ed25519.PublicKey  // 32 bytes
}

// PublicKeyBase64 returns the base64-encoded public key string.
// This is the "key" value that RustDesk clients use to verify the server.
func (kp *KeyPair) PublicKeyBase64() string {
	return base64.StdEncoding.EncodeToString(kp.PublicKey)
}

// PrivateKeyBase64 returns the base64-encoded private key (64 bytes).
func (kp *KeyPair) PrivateKeyBase64() string {
	return base64.StdEncoding.EncodeToString(kp.PrivateKey)
}

// SignIdPk signs an IdPk protobuf message with the server's private key.
// Returns NaCl combined format: [ 64-byte Ed25519 signature ][ IdPk protobuf bytes ]
// This matches libsodium crypto_sign() / sodiumoxide sign::sign() used by RustDesk.
// RustDesk clients use decode_id_pk() with sign::verify() to extract and verify the payload.
func (kp *KeyPair) SignIdPk(id string, pk []byte) ([]byte, error) {
	idpk := &pb.IdPk{
		Id: id,
		Pk: pk,
	}
	data, err := proto.Marshal(idpk)
	if err != nil {
		return nil, fmt.Errorf("keys: failed to marshal IdPk: %w", err)
	}
	// Ed25519 signature is 64 bytes
	sig := ed25519.Sign(kp.PrivateKey, data)
	// NaCl combined format: [64-byte Ed25519 signature][serialized IdPk protobuf]
	// RustDesk clients decode this with sign::verify(server_pub_key, signed_bytes)
	// which strips the signature and returns the IdPk payload.
	const maxSignedPayload = 1 << 20 // 1 MiB upper bound for protobuf payload
	if len(data) > maxSignedPayload {
		return nil, fmt.Errorf("keys: IdPk payload too large")
	}
	result := make([]byte, len(sig)+len(data))
	copy(result, sig)
	copy(result[len(sig):], data)

	return result, nil
}

// GenerateKeyPair creates a new Ed25519 key pair.
func GenerateKeyPair() (*KeyPair, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("keys: failed to generate key pair: %w", err)
	}
	return &KeyPair{PrivateKey: priv, PublicKey: pub}, nil
}

// LoadOrGenerateKeyPair loads an existing key pair from files, or generates a new one.
// Files: <basePath> (private key, base64) and <basePath>.pub (public key, base64)
func LoadOrGenerateKeyPair(basePath string) (*KeyPair, error) {
	privPath := basePath
	pubPath := basePath + ".pub"

	// Try loading existing key
	if _, err := os.Stat(privPath); err == nil {
		return loadKeyPairFromFiles(privPath, pubPath)
	}

	// Generate new key pair
	kp, err := GenerateKeyPair()
	if err != nil {
		return nil, err
	}

	// Save to files
	if err := saveKeyPairToFiles(kp, privPath, pubPath); err != nil {
		return nil, err
	}

	return kp, nil
}

// LoadKeyPairFromBase64 loads a key pair from a base64-encoded private key string.
// This is compatible with RustDesk's key format where the private key is 64 bytes.
func LoadKeyPairFromBase64(b64 string) (*KeyPair, error) {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("keys: invalid base64: %w", err)
	}
	if len(data) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("keys: invalid private key size %d (expected %d)", len(data), ed25519.PrivateKeySize)
	}
	priv := ed25519.PrivateKey(data)
	pub := priv.Public().(ed25519.PublicKey)
	return &KeyPair{PrivateKey: priv, PublicKey: pub}, nil
}

func loadKeyPairFromFiles(privPath, pubPath string) (*KeyPair, error) {
	privB64, err := os.ReadFile(privPath)
	if err != nil {
		return nil, fmt.Errorf("keys: failed to read private key %q: %w", privPath, err)
	}

	kp, err := LoadKeyPairFromBase64(string(privB64))
	if err != nil {
		return nil, err
	}

	// Verify public key file matches if it exists
	if pubB64, err := os.ReadFile(pubPath); err == nil {
		pubData, err := base64.StdEncoding.DecodeString(string(pubB64))
		if err == nil && len(pubData) == ed25519.PublicKeySize {
			expected := ed25519.PublicKey(pubData)
			if !kp.PublicKey.Equal(expected) {
				return nil, fmt.Errorf("keys: public key file does not match private key")
			}
		}
	}

	return kp, nil
}

func saveKeyPairToFiles(kp *KeyPair, privPath, pubPath string) error {
	privB64 := kp.PrivateKeyBase64()
	if err := os.WriteFile(privPath, []byte(privB64), 0600); err != nil {
		return fmt.Errorf("keys: failed to write private key: %w", err)
	}

	pubB64 := kp.PublicKeyBase64()
	if err := os.WriteFile(pubPath, []byte(pubB64), 0644); err != nil {
		return fmt.Errorf("keys: failed to write public key: %w", err)
	}

	return nil
}
