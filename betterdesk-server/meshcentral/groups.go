package meshcentral

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// MeshGroup represents a MeshCentral device group mapped to BetterDesk folders.
// MeshID is the 96-hex (SHA-384) group identity written into MeshAgent .msh files.
type MeshGroup struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	MeshID string `json:"mesh_id,omitempty"`
}

const (
	meshIDHexSHA256 = 64
	meshIDHexSHA384 = 96
)

// NewMeshIDHex generates a stable 48-byte (96 hex) MeshID for a device group.
func NewMeshIDHex() (string, error) {
	b := make([]byte, 48)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("mesh: generate mesh id: %w", err)
	}
	return strings.ToUpper(hex.EncodeToString(b)), nil
}

// NormalizeMeshIDHex strips an optional 0x prefix and uppercases hex digits.
func NormalizeMeshIDHex(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "0x")
	s = strings.TrimPrefix(s, "0X")
	return strings.ToUpper(s)
}

// IsValidMeshIDHex reports whether s is a MeshAgent-acceptable MeshID
// (32-byte/64-hex SHA-256 or 48-byte/96-hex SHA-384), with or without 0x.
func IsValidMeshIDHex(s string) bool {
	s = NormalizeMeshIDHex(s)
	if len(s) != meshIDHexSHA256 && len(s) != meshIDHexSHA384 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// ensureGroupMeshIDs fills missing/invalid MeshID fields. Returns whether any group changed.
func ensureGroupMeshIDs(groups []MeshGroup) ([]MeshGroup, bool, error) {
	changed := false
	if len(groups) == 0 {
		id, err := NewMeshIDHex()
		if err != nil {
			return nil, false, err
		}
		return []MeshGroup{{ID: "default", Name: "Default Mesh", MeshID: id}}, true, nil
	}
	out := make([]MeshGroup, len(groups))
	for i, g := range groups {
		out[i] = g
		if IsValidMeshIDHex(g.MeshID) {
			norm := NormalizeMeshIDHex(g.MeshID)
			if norm != g.MeshID {
				out[i].MeshID = norm
				changed = true
			}
			continue
		}
		// Legacy: operators may have stored the hex identity in ID itself.
		if IsValidMeshIDHex(g.ID) {
			out[i].MeshID = NormalizeMeshIDHex(g.ID)
			changed = true
			continue
		}
		id, err := NewMeshIDHex()
		if err != nil {
			return nil, false, err
		}
		out[i].MeshID = id
		changed = true
	}
	return out, changed, nil
}
