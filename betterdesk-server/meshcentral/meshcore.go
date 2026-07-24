package meshcentral

import (
	"crypto/sha512"
	"embed"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed assets/bettercore.js
var embeddedAssets embed.FS

// CoreAssets holds BetterCore (AGPL) pushed to MeshAgent after handshake.
type CoreAssets struct {
	CoreModule     []byte
	CoreModuleHash []byte // 48-byte SHA-384
	Version        string
}

// LoadCoreAssets reads meshcore from disk override or embedded bundle.
func LoadCoreAssets(version string, assetsDir string) (*CoreAssets, error) {
	corePath := filepath.Join(assetsDir, "bettercore.js")
	core, err := readAsset(corePath, "assets/bettercore.js")
	if err != nil {
		return nil, fmt.Errorf("meshcore: %w", err)
	}
	h := sha512.Sum384(core)
	return &CoreAssets{
		CoreModule:     core,
		CoreModuleHash: h[:],
		Version:        version,
	}, nil
}

func readAsset(path, embedName string) ([]byte, error) {
	if path != "" {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return data, nil
		}
	}
	return embeddedAssets.ReadFile(embedName)
}

// BuildCoreModulePacket returns cmd 10 binary packet with core JS.
func BuildCoreModulePacket(core []byte) []byte {
	pkt := make([]byte, 4+len(core))
	binaryPutU16(pkt, 0, cmdCoreModule)
	binaryPutU16(pkt, 2, 0)
	copy(pkt[4:], core)
	return pkt
}

// BuildCoreOkPacket returns cmd 16 (core approved).
func BuildCoreOkPacket() []byte {
	p := make([]byte, 2)
	binaryPutU16(p, 0, cmdCoreOk)
	return p
}

// BuildCoreModuleHashRequest requests agent core hash (cmd 11).
func BuildCoreModuleHashRequest() []byte {
	p := make([]byte, 4)
	binaryPutU16(p, 0, cmdCoreModuleHash)
	binaryPutU16(p, 2, 0)
	return p
}

func binaryPutU16(b []byte, off int, v uint16) {
	b[off] = byte(v >> 8)
	b[off+1] = byte(v)
}
