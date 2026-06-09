package signalhost

import (
	"crypto/sha256"
)

// hashPassword matches RustDesk / betterdesk-mgmt login hashing.
// SHA-256 is required by the RustDesk wire protocol (not a storage hash).
func hashPassword(password, salt, challenge string) [32]byte {
	step1 := sha256.Sum256(append(append([]byte{}, password...), salt...))
	return sha256.Sum256(append(step1[:], challenge...))
}
