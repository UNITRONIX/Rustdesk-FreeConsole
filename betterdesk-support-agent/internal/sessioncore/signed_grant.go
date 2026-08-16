package sessioncore

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const signedGrantVersion = "v1"
const maxGrantLifetime = 10 * time.Minute

// Ed25519GrantVerifier validates the compact signed grant envelope emitted by
// BetterDesk Server. It is implemented in the Support Agent without importing
// server packages, so the native session core retains a narrow, auditable
// verification boundary.
type Ed25519GrantVerifier struct {
	publicKey ed25519.PublicKey
	now       func() time.Time
}

// NewEd25519GrantVerifier parses a base64 Ed25519 public key. Both padded and
// unpadded standard base64 are accepted for operational copy/paste safety.
func NewEd25519GrantVerifier(encodedPublicKey string) (*Ed25519GrantVerifier, error) {
	raw, err := decodeEd25519PublicKey(encodedPublicKey)
	if err != nil {
		return nil, err
	}
	return &Ed25519GrantVerifier{publicKey: ed25519.PublicKey(raw), now: time.Now}, nil
}

// VerifySessionGrant implements GrantVerifier.
func (v *Ed25519GrantVerifier) VerifySessionGrant(_ context.Context, presentation string) (SessionGrant, error) {
	if v == nil || len(v.publicKey) != ed25519.PublicKeySize {
		return SessionGrant{}, ErrGrantVerification
	}
	parts := strings.Split(presentation, ".")
	if len(parts) != 3 || parts[0] != signedGrantVersion {
		return SessionGrant{}, ErrGrantVerification
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return SessionGrant{}, ErrGrantVerification
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(v.publicKey, payload, signature) {
		return SessionGrant{}, ErrGrantVerification
	}

	var claims signedGrantClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return SessionGrant{}, ErrGrantVerification
	}
	if claims.Version != 1 || strings.TrimSpace(claims.Audience) == "" ||
		strings.TrimSpace(claims.DeviceID) == "" || strings.TrimSpace(claims.OperatorID) == "" ||
		strings.TrimSpace(claims.SessionID) == "" || strings.TrimSpace(claims.Transport) == "" ||
		strings.TrimSpace(claims.Initiator) != string(InitiatorOperator) {
		return SessionGrant{}, ErrGrantVerification
	}
	now := v.now().UTC().Unix()
	if claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt ||
		claims.IssuedAt > now+30 || claims.ExpiresAt-claims.IssuedAt > int64(maxGrantLifetime/time.Second) {
		return SessionGrant{}, ErrGrantVerification
	}
	if claims.ExpiresAt <= now {
		return SessionGrant{}, ErrGrantExpired
	}
	capabilities := make([]Capability, 0, len(claims.Capabilities))
	for _, capability := range claims.Capabilities {
		capabilities = append(capabilities, Capability(strings.TrimSpace(strings.ToLower(capability))))
	}
	if _, err := validatePassiveCapabilities(capabilities); err != nil {
		return SessionGrant{}, err
	}
	return SessionGrant{
		Audience:     strings.TrimSpace(claims.Audience),
		DeviceID:     strings.TrimSpace(claims.DeviceID),
		OperatorID:   strings.TrimSpace(claims.OperatorID),
		SessionID:    strings.TrimSpace(claims.SessionID),
		Transport:    strings.TrimSpace(strings.ToLower(claims.Transport)),
		Capabilities: capabilities,
		ExpiresAt:    time.Unix(claims.ExpiresAt, 0).UTC(),
		Initiator:    InitiatorOperator,
	}, nil
}

type signedGrantClaims struct {
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
}

func decodeEd25519PublicKey(encoded string) ([]byte, error) {
	encoded = strings.TrimSpace(encoded)
	for _, decoder := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding} {
		raw, err := decoder.DecodeString(encoded)
		if err == nil && len(raw) == ed25519.PublicKeySize {
			return raw, nil
		}
	}
	return nil, fmt.Errorf("invalid session-grant Ed25519 public key")
}
