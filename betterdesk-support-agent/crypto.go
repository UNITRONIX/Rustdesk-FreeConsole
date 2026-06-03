package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
)

// State-at-rest encryption.
//
// The agent's local state (device identity + access password) must not be
// trivially readable or, more importantly, copyable to another machine to
// impersonate this device. The state file is therefore encrypted with
// AES-256-GCM using a key derived from a platform-stable machine identifier
// (the same seed that anchors the device ID). Because the key never leaves the
// machine and is bound to it, a state file copied elsewhere fails to decrypt
// and the agent regenerates a fresh identity instead of cloning this one.

// stateMagic prefixes every encrypted state blob so the loader can tell an
// encrypted file from a legacy plaintext one.
var stateMagic = []byte("BDSE1\x00")

// stateKey derives the 32-byte AES key bound to this machine. The machine seed
// is mixed with a domain-separation label so the key cannot collide with other
// machine-seed uses (e.g. the device ID derivation).
func stateKey() [32]byte {
	seed := machineSeed()
	if seed == "" {
		// No stable machine identifier: fall back to a hostname-less constant.
		// State stays encrypted but is effectively portable on this host only.
		seed = "betterdesk-support-no-machine-id"
	}
	return sha256.Sum256([]byte("betterdesk-support-state-key-v1|" + seed))
}

// encryptState seals plaintext into a machine-bound envelope:
// magic | nonce(12) | ciphertext+tag.
func encryptState(plaintext []byte) ([]byte, error) {
	key := stateKey()
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
	sealed := gcm.Seal(nil, nonce, plaintext, stateMagic)

	out := make([]byte, 0, len(stateMagic)+len(nonce)+len(sealed))
	out = append(out, stateMagic...)
	out = append(out, nonce...)
	out = append(out, sealed...)
	return out, nil
}

// decryptState opens an envelope produced by encryptState. It returns an error
// when the blob is not encrypted, is truncated, or was sealed on a different
// machine (authentication fails).
func decryptState(blob []byte) ([]byte, error) {
	if !isEncryptedState(blob) {
		return nil, fmt.Errorf("not an encrypted state blob")
	}
	body := blob[len(stateMagic):]

	key := stateKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(body) < ns {
		return nil, fmt.Errorf("state blob too short")
	}
	nonce, ciphertext := body[:ns], body[ns:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, stateMagic)
	if err != nil {
		return nil, fmt.Errorf("decrypt state (wrong machine or corrupted): %w", err)
	}
	return plaintext, nil
}

// isEncryptedState reports whether the blob carries the encrypted-state magic.
func isEncryptedState(blob []byte) bool {
	if len(blob) < len(stateMagic) {
		return false
	}
	for i := range stateMagic {
		if blob[i] != stateMagic[i] {
			return false
		}
	}
	return true
}
