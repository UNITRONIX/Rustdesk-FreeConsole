package signalhost

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

type identity struct {
	publicKey ed25519.PublicKey
	secretKey ed25519.PrivateKey
	uuid      []byte
}

func loadIdentity(dataDir, deviceUUID string) (*identity, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	skPath := filepath.Join(dataDir, "signal_ed25519")
	pkPath := filepath.Join(dataDir, "signal_ed25519.pub")

	id := &identity{}
	if skData, err := os.ReadFile(skPath); err == nil && len(skData) == ed25519.PrivateKeySize {
		id.secretKey = ed25519.PrivateKey(skData)
		id.publicKey = id.secretKey.Public().(ed25519.PublicKey)
	} else {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		id.publicKey = pub
		id.secretKey = priv
		if err := os.WriteFile(skPath, []byte(priv), 0o600); err != nil {
			return nil, err
		}
		if err := os.WriteFile(pkPath, []byte(pub), 0o644); err != nil {
			return nil, err
		}
	}

	if deviceUUID != "" {
		if b, err := hex.DecodeString(deviceUUID); err == nil && len(b) > 0 {
			id.uuid = b
		}
	}
	if len(id.uuid) == 0 {
		id.uuid = make([]byte, 16)
		if _, err := rand.Read(id.uuid); err != nil {
			return nil, err
		}
		_ = os.WriteFile(filepath.Join(dataDir, "signal_uuid"), id.uuid, 0o600)
	}
	return id, nil
}

func (id *identity) pkBytes() []byte {
	return []byte(id.publicKey)
}

func (id *identity) String() string {
	return fmt.Sprintf("pk=%dB uuid=%dB", len(id.publicKey), len(id.uuid))
}
