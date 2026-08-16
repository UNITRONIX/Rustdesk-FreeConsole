// Package sessiongrant signs short-lived, target-bound grants for passive
// Support Agent sessions. It is intentionally transport-neutral so relay,
// CDAP, and future compatibility adapters can apply the same authorization
// decision.
package sessiongrant

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	tokenVersion = "v1"
	audience     = "betterdesk-support-agent"
	maxTTL       = 10 * time.Minute
)

// Claims binds a server authorization decision to exactly one target-side
// session. It never contains a password, TOTP value, device token, or other
// long-lived secret.
type Claims struct {
	Version      int      `json:"v"`
	Audience     string   `json:"aud"`
	DeviceID     string   `json:"device_id"`
	OperatorID   string   `json:"operator_id"`
	SessionID    string   `json:"session_id"`
	Transport    string   `json:"transport"`
	Initiator    string   `json:"initiator"`
	Capabilities []string `json:"capabilities"`
	IssuedAt     int64    `json:"iat"`
	ExpiresAt    int64    `json:"exp"`
	Nonce        string   `json:"nonce"`
}

// Signer holds the server-side signing material. Only public keys are given to
// agents for verification.
type Signer struct {
	privateKey ed25519.PrivateKey
	now        func() time.Time
}

// NewSigner constructs a signer from an existing Ed25519 private key.
func NewSigner(privateKey ed25519.PrivateKey) (*Signer, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid Ed25519 private key length")
	}
	return &Signer{privateKey: privateKey, now: time.Now}, nil
}

// PublicKey returns the verifier material safe to distribute to agents.
func (s *Signer) PublicKey() ed25519.PublicKey {
	return s.privateKey.Public().(ed25519.PublicKey)
}

// Issue creates a signed grant. The supplied claims must have an explicit,
// short expiration; the server refuses to create grants wider than maxTTL.
func (s *Signer) Issue(claims Claims) (string, error) {
	if s == nil || len(s.privateKey) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("session grant signer is unavailable")
	}
	now := s.now().UTC()
	claims = normalize(claims)
	if claims.Version == 0 {
		claims.Version = 1
	}
	if claims.Audience == "" {
		claims.Audience = audience
	}
	if claims.IssuedAt == 0 {
		claims.IssuedAt = now.Unix()
	}
	if err := validate(claims, now); err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal session grant: %w", err)
	}
	signature := ed25519.Sign(s.privateKey, payload)
	return strings.Join([]string{
		tokenVersion,
		base64.RawURLEncoding.EncodeToString(payload),
		base64.RawURLEncoding.EncodeToString(signature),
	}, "."), nil
}

// Verify checks the signature and all target-side invariants. expectedDeviceID
// and expectedTransport prevent a valid grant from being replayed to another
// agent or transport adapter.
func Verify(token string, publicKey ed25519.PublicKey, expectedDeviceID, expectedTransport string, now time.Time) (Claims, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return Claims{}, fmt.Errorf("invalid session-grant public key")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != tokenVersion {
		return Claims{}, fmt.Errorf("invalid session-grant format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, fmt.Errorf("decode session-grant payload: %w", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Claims{}, fmt.Errorf("invalid session-grant signature")
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return Claims{}, fmt.Errorf("session-grant signature verification failed")
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, fmt.Errorf("decode session grant: %w", err)
	}
	claims = normalize(claims)
	if err := validate(claims, now.UTC()); err != nil {
		return Claims{}, err
	}
	if expectedDeviceID != "" && claims.DeviceID != expectedDeviceID {
		return Claims{}, fmt.Errorf("session grant is for another device")
	}
	if expectedTransport != "" && claims.Transport != expectedTransport {
		return Claims{}, fmt.Errorf("session grant is for another transport")
	}
	return claims, nil
}

func normalize(claims Claims) Claims {
	claims.Audience = strings.TrimSpace(claims.Audience)
	claims.DeviceID = strings.TrimSpace(claims.DeviceID)
	claims.OperatorID = strings.TrimSpace(claims.OperatorID)
	claims.SessionID = strings.TrimSpace(claims.SessionID)
	claims.Transport = strings.TrimSpace(strings.ToLower(claims.Transport))
	claims.Initiator = strings.TrimSpace(strings.ToLower(claims.Initiator))
	claims.Nonce = strings.TrimSpace(claims.Nonce)
	caps := make([]string, 0, len(claims.Capabilities))
	for _, cap := range claims.Capabilities {
		if cap = strings.TrimSpace(strings.ToLower(cap)); cap != "" {
			caps = append(caps, cap)
		}
	}
	sort.Strings(caps)
	claims.Capabilities = caps[:0]
	for _, cap := range caps {
		if len(claims.Capabilities) == 0 || claims.Capabilities[len(claims.Capabilities)-1] != cap {
			claims.Capabilities = append(claims.Capabilities, cap)
		}
	}
	return claims
}

func validate(claims Claims, now time.Time) error {
	if claims.Version != 1 {
		return fmt.Errorf("unsupported session-grant version")
	}
	if claims.Audience != audience {
		return fmt.Errorf("invalid session-grant audience")
	}
	if claims.DeviceID == "" || claims.OperatorID == "" || claims.SessionID == "" || claims.Nonce == "" {
		return fmt.Errorf("session grant is missing a required binding")
	}
	switch claims.Transport {
	case "cdap", "relay", "interop":
	default:
		return fmt.Errorf("unsupported session-grant transport")
	}
	if claims.Initiator != "operator" {
		return fmt.Errorf("session grant must be initiated by an operator")
	}
	if claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt <= now.Unix() {
		return fmt.Errorf("session grant has expired")
	}
	if time.Unix(claims.ExpiresAt, 0).Sub(time.Unix(claims.IssuedAt, 0)) > maxTTL {
		return fmt.Errorf("session grant exceeds maximum lifetime")
	}
	if len(claims.Capabilities) == 0 {
		return fmt.Errorf("session grant has no capabilities")
	}
	return nil
}
