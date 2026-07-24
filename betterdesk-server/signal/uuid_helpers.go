package signal

import (
	"bytes"
	"encoding/hex"
)

// peerUUIDFromDB converts the UUID string stored in the peers table into the
// 16-byte binary form used on the wire in RegisterPk messages.
//
// Enrollment stores machine UUIDs as lowercase hex (no dashes). RegisterPk
// persists fmt.Sprintf("%x", msg.Uuid). Loading with []byte(dbPeer.UUID)
// produced ASCII hex bytes and caused perpetual UUID_MISMATCH (#213).
func peerUUIDFromDB(stored string) []byte {
	if stored == "" {
		return nil
	}
	if decoded, err := hex.DecodeString(stored); err == nil && len(decoded) > 0 {
		return decoded
	}
	return []byte(stored)
}

func peerUUIDEqual(a, b []byte) bool {
	return bytes.Equal(normalizePeerUUIDBytes(a), normalizePeerUUIDBytes(b))
}

func normalizePeerUUIDBytes(raw []byte) []byte {
	if len(raw) == 0 {
		return nil
	}
	// Wire format: 16-byte binary UUID.
	if len(raw) == 16 {
		return raw
	}
	// Legacy in-memory bug: ASCII hex string loaded via []byte(dbPeer.UUID).
	if len(raw) == 32 || len(raw)%2 == 0 {
		if decoded, err := hex.DecodeString(string(raw)); err == nil && len(decoded) > 0 {
			return decoded
		}
	}
	return raw
}
