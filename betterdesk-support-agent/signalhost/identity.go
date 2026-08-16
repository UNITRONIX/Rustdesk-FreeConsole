package signalhost

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return nil, err
	}
	skPath := filepath.Join(dataDir, "signal_ed25519")
	pkPath := filepath.Join(dataDir, "signal_ed25519.pub")

	id := &identity{}
	skData, err := os.ReadFile(skPath)
	switch {
	case err == nil:
		if len(skData) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("invalid stored signal identity key length")
		}
		id.secretKey = ed25519.PrivateKey(skData)
		id.publicKey = id.secretKey.Public().(ed25519.PublicKey)
	case !errors.Is(err, os.ErrNotExist):
		return nil, fmt.Errorf("read signal identity: %w", err)
	default:
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		id.publicKey = pub
		id.secretKey = priv
		file, err := os.OpenFile(skPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if !errors.Is(err, os.ErrExist) {
				return nil, fmt.Errorf("create signal identity: %w", err)
			}
			// Another process created the identity while this one was
			// generating it. Re-read rather than replacing that identity.
			skData, readErr := os.ReadFile(skPath)
			if readErr != nil {
				return nil, fmt.Errorf("read concurrently-created signal identity: %w", readErr)
			}
			if len(skData) != ed25519.PrivateKeySize {
				return nil, fmt.Errorf("invalid concurrently-created signal identity key length")
			}
			id.secretKey = ed25519.PrivateKey(skData)
			id.publicKey = id.secretKey.Public().(ed25519.PublicKey)
		} else {
			if _, err := file.Write(priv); err != nil {
				_ = file.Close()
				return nil, fmt.Errorf("write signal identity: %w", err)
			}
			if err := file.Close(); err != nil {
				return nil, fmt.Errorf("close signal identity: %w", err)
			}
		}
	}
	if err := os.WriteFile(pkPath, []byte(id.publicKey), 0o644); err != nil {
		return nil, err
	}

	if deviceUUID != "" {
		if b, err := hex.DecodeString(deviceUUID); err == nil && len(b) == 16 {
			id.uuid = b
		}
	}
	if len(id.uuid) == 0 {
		uuidPath := filepath.Join(dataDir, "signal_uuid")
		if existing, err := os.ReadFile(uuidPath); err == nil {
			if len(existing) != 16 {
				return nil, fmt.Errorf("invalid stored signal UUID length")
			}
			id.uuid = existing
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("read signal UUID: %w", err)
		} else {
			id.uuid = make([]byte, 16)
			if _, err := rand.Read(id.uuid); err != nil {
				return nil, err
			}
			file, err := os.OpenFile(uuidPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				if !errors.Is(err, os.ErrExist) {
					return nil, fmt.Errorf("create signal UUID: %w", err)
				}
				existing, readErr := os.ReadFile(uuidPath)
				if readErr != nil {
					return nil, fmt.Errorf("read concurrently-created signal UUID: %w", readErr)
				}
				if len(existing) != 16 {
					return nil, fmt.Errorf("invalid concurrently-created signal UUID length")
				}
				id.uuid = existing
			} else {
				if _, err := file.Write(id.uuid); err != nil {
					_ = file.Close()
					return nil, fmt.Errorf("write signal UUID: %w", err)
				}
				if err := file.Close(); err != nil {
					return nil, fmt.Errorf("close signal UUID: %w", err)
				}
			}
		}
	}
	return id, nil
}

func (id *identity) pkBytes() []byte {
	return []byte(id.publicKey)
}

func (id *identity) String() string {
	return fmt.Sprintf("pk=%dB uuid=%dB", len(id.publicKey), len(id.uuid))
}
