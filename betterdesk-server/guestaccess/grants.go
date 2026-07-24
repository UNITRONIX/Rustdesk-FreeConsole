// Package guestaccess implements temporary Guest Access Links for Web Remote / RdClient.
// Grants store a multi-device peer allowlist with TTL; raw tokens are never persisted
// (SHA-256 hash only in server_config under guest_access_<hash>).
package guestaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

const configPrefix = "gal_"

// MaxTTLMinutes caps link lifetime (24h).
const MaxTTLMinutes = 24 * 60

// DefaultTTLMinutes used when caller passes <= 0.
const DefaultTTLMinutes = 60

// Grant is the persisted grant payload (JSON in server_config).
type Grant struct {
	ID          string     `json:"id"`
	PeerIDs     []string   `json:"peer_ids"`
	CreatedBy   string     `json:"created_by"`
	Label       string     `json:"label,omitempty"`
	ViewOnly    bool       `json:"view_only"`
	ExpiresAt   time.Time  `json:"expires_at"`
	CreatedAt   time.Time  `json:"created_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	MaxUses     int        `json:"max_uses,omitempty"`
	UseCount    int        `json:"use_count,omitempty"`
	TokenPrefix string     `json:"token_prefix,omitempty"`
}

// PublicGrant is safe metadata returned by validate (no secrets).
type PublicGrant struct {
	Valid     bool      `json:"valid"`
	PeerIDs   []string  `json:"peer_ids"`
	ViewOnly  bool      `json:"view_only"`
	ExpiresAt time.Time `json:"expires_at"`
	Label     string    `json:"label,omitempty"`
	CreatedBy string    `json:"created_by,omitempty"`
}

// Store persists grants via the server config KV.
type Store struct {
	DB db.Database
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	// 48 hex chars (192 bits) — keeps config keys short
	return hex.EncodeToString(sum[:24])
}

func newToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func newID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func normalizePeerIDs(ids []string) ([]string, error) {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if len(id) < 3 || len(id) > 64 {
			return nil, fmt.Errorf("invalid peer id length")
		}
		for _, c := range id {
			if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
				return nil, fmt.Errorf("invalid peer id characters")
			}
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one peer_id required")
	}
	return out, nil
}

func (s *Store) configKey(tokenHash string) string {
	return configPrefix + tokenHash
}

// Create issues a new guest access link. Returns the raw token once.
func (s *Store) Create(peerIDs []string, createdBy string, ttlMinutes int, viewOnly bool, label string, maxUses int) (rawToken string, grant *Grant, err error) {
	if s == nil || s.DB == nil {
		return "", nil, fmt.Errorf("guest access store not configured")
	}
	peers, err := normalizePeerIDs(peerIDs)
	if err != nil {
		return "", nil, err
	}
	if ttlMinutes <= 0 {
		ttlMinutes = DefaultTTLMinutes
	}
	if ttlMinutes > MaxTTLMinutes {
		ttlMinutes = MaxTTLMinutes
	}
	if maxUses < 0 {
		maxUses = 0
	}
	token, err := newToken()
	if err != nil {
		return "", nil, err
	}
	id, err := newID()
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UTC()
	g := &Grant{
		ID:          id,
		PeerIDs:     peers,
		CreatedBy:   createdBy,
		Label:       strings.TrimSpace(label),
		ViewOnly:    viewOnly,
		ExpiresAt:   now.Add(time.Duration(ttlMinutes) * time.Minute),
		CreatedAt:   now,
		MaxUses:     maxUses,
		TokenPrefix: token[:8],
	}
	b, err := json.Marshal(g)
	if err != nil {
		return "", nil, err
	}
	if err := s.DB.SetConfig(s.configKey(hashToken(token)), string(b)); err != nil {
		return "", nil, err
	}
	return token, g, nil
}

func (s *Store) loadByHash(tokenHash string) (*Grant, error) {
	raw, err := s.DB.GetConfig(s.configKey(tokenHash))
	if err != nil || raw == "" {
		return nil, fmt.Errorf("invalid or expired guest link")
	}
	var g Grant
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		return nil, fmt.Errorf("invalid guest grant")
	}
	return &g, nil
}

func (s *Store) save(tokenHash string, g *Grant) error {
	b, err := json.Marshal(g)
	if err != nil {
		return err
	}
	return s.DB.SetConfig(s.configKey(tokenHash), string(b))
}

func (g *Grant) allowsPeer(peerID string) bool {
	peerID = strings.TrimSpace(peerID)
	for _, id := range g.PeerIDs {
		if id == peerID {
			return true
		}
	}
	return false
}

func (g *Grant) isActive() error {
	if g.RevokedAt != nil {
		return fmt.Errorf("guest link revoked")
	}
	if time.Now().UTC().After(g.ExpiresAt) {
		return fmt.Errorf("guest link expired")
	}
	if g.MaxUses > 0 && g.UseCount >= g.MaxUses {
		return fmt.Errorf("guest link use limit reached")
	}
	return nil
}

// Validate checks token (and optional peerID membership). peerID empty = list-only validate.
func (s *Store) Validate(token, peerID string) (*Grant, error) {
	if s == nil || s.DB == nil {
		return nil, fmt.Errorf("guest access store not configured")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("missing guest token")
	}
	tokenHash := hashToken(token)
	g, err := s.loadByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if err := g.isActive(); err != nil {
		if strings.Contains(err.Error(), "expired") {
			_ = s.DB.DeleteConfig(s.configKey(tokenHash))
		}
		return nil, err
	}
	if peerID != "" && !g.allowsPeer(peerID) {
		return nil, fmt.Errorf("guest link does not allow this device")
	}
	return g, nil
}

// Touch increments use_count after a successful session open (optional).
func (s *Store) Touch(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("missing guest token")
	}
	tokenHash := hashToken(token)
	g, err := s.loadByHash(tokenHash)
	if err != nil {
		return err
	}
	g.UseCount++
	return s.save(tokenHash, g)
}

// RevokeByID marks a grant revoked. Returns true if found.
func (s *Store) RevokeByID(id, createdBy string, admin bool) (bool, error) {
	entries, err := s.DB.ListConfigByPrefix(configPrefix)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		var g Grant
		if err := json.Unmarshal([]byte(e.Value), &g); err != nil {
			continue
		}
		if g.ID != id {
			continue
		}
		if !admin && createdBy != "" && g.CreatedBy != createdBy {
			return false, fmt.Errorf("forbidden")
		}
		now := time.Now().UTC()
		g.RevokedAt = &now
		tokenHash := strings.TrimPrefix(e.Key, configPrefix)
		if err := s.save(tokenHash, &g); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

// ListActive returns non-revoked, non-expired grants (optionally filtered by creator).
func (s *Store) ListActive(createdBy string, admin bool) ([]*Grant, error) {
	entries, err := s.DB.ListConfigByPrefix(configPrefix)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	out := make([]*Grant, 0)
	for _, e := range entries {
		var g Grant
		if err := json.Unmarshal([]byte(e.Value), &g); err != nil {
			continue
		}
		if g.RevokedAt != nil || now.After(g.ExpiresAt) {
			continue
		}
		if !admin && createdBy != "" && g.CreatedBy != createdBy {
			continue
		}
		cp := g
		out = append(out, &cp)
	}
	return out, nil
}

// ToPublic builds the public validate response.
func ToPublic(g *Grant) PublicGrant {
	return PublicGrant{
		Valid:     true,
		PeerIDs:   append([]string(nil), g.PeerIDs...),
		ViewOnly:  g.ViewOnly,
		ExpiresAt: g.ExpiresAt,
		Label:     g.Label,
		CreatedBy: g.CreatedBy,
	}
}
