package signalhost

import (
	"crypto/sha256"
)

// hashPassword matches RustDesk / betterdesk-mgmt login hashing on the wire.
// SHA-256 is required by the RustDesk protocol (not password storage).
func hashPassword(password, salt, challenge string) [32]byte {
	step1 := sha256.Sum256(append(append([]byte{}, password...), salt...))
	return sha256.Sum256(append(step1[:], challenge...))
}
