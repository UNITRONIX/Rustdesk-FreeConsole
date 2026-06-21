// Package meshcentral implements the MeshCentral wire-protocol compatibility layer
// for BetterDesk (AGPL). Enables unmodified MeshAgent binaries to register and
// receive remote desktop / terminal / file sessions via /agent.ashx endpoints.
package meshcentral

import (
	"encoding/binary"
)

const (
	sha384Size = 48

	cmdAuthRequest           = 1
	cmdAuthVerify            = 2
	cmdAuthInfo              = 3
	cmdAuthConfirm           = 4
	cmdServerID              = 5
	cmdCoreModule            = 10
	cmdCoreModuleHash        = 11
	cmdCoreOk                = 16
	cmdCompressedCoreModule  = 20

	relayProtocolKVM      = 2
	relayProtocolTerminal = 1
	relayProtocolFiles    = 5
)

func writeU16(v uint16) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, v)
	return b
}

func readU16(data []byte, off int) uint16 {
	if off+2 > len(data) {
		return 0
	}
	return binary.BigEndian.Uint16(data[off:])
}

func readU32(data []byte, off int) uint32 {
	if off+4 > len(data) {
		return 0
	}
	return binary.BigEndian.Uint32(data[off:])
}

func writeU32(v uint32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return b
}
