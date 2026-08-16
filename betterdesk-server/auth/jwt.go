package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Claims represents the JWT payload.
type Claims struct {
	Sub   string `json:"sub"`              // Subject (username)
	Role  string `json:"role"`             // User role (admin, operator, viewer)
	OrgID string `json:"org_id,omitempty"` // Organization ID (empty = global/server-level user)
	Iat   int64  `json:"iat"`              // Issued at (Unix)
	Exp   int64  `json:"exp"`              // Expires at (Unix)
	Jti   string `json:"jti,omitempty"`    // JWT ID (for revocation)
}

// JWTManager generates and validates HS256 JWT tokens.
type JWTManager struct {
	secret []byte
	expiry time.Duration
}

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

var (
	ErrInvalidToken = errors.New("auth: invalid token")
	ErrTokenExpired = errors.New("auth: token expired")
)

// NewJWTManager creates a JWT manager with the given secret and token expiry duration.
func NewJWTManager(secret string, expiry time.Duration) *JWTManager {
	return &JWTManager{
		secret: []byte(secret),
		expiry: expiry,
	}
}

// Secret returns the signing secret (also used to seal access-policy connect secrets).
func (m *JWTManager) Secret() string {
	if m == nil {
		return ""
	}
	return string(m.secret)
}

// Generate creates a new signed JWT token for the given subject and role.
func (m *JWTManager) Generate(subject, role string) (string, error) {
	return m.GenerateWithTTL(subject, role, m.expiry)
}

// GenerateWithTTL creates a new signed JWT token with a custom time-to-live.
// This is used for short-lived tokens such as partial 2FA tokens (H4).
func (m *JWTManager) GenerateWithTTL(subject, role string, ttl time.Duration) (string, error) {
	return m.GenerateOrgToken(subject, role, "", ttl)
}

// GenerateOrgToken creates a signed JWT token with an organization context.
// If orgID is empty, the token is a global/server-level token.
func (m *JWTManager) GenerateOrgToken(subject, role, orgID string, ttl time.Duration) (string, error) {
	jti, err := GenerateRandomString(16)
	if err != nil {
		return "", fmt.Errorf("auth: generate jti: %w", err)
	}
	now := time.Now().Unix()
	claims := Claims{
		Sub:   subject,
		Role:  role,
		OrgID: orgID,
		Iat:   now,
		Exp:   now + int64(ttl.Seconds()),
		Jti:   jti,
	}

	hdr := b64URLEncode(mustJSON(jwtHeader{Alg: "HS256", Typ: "JWT"}))
	pay := b64URLEncode(mustJSON(claims))
	sig := m.sign(hdr + "." + pay)

	return hdr + "." + pay + "." + sig, nil
}

// Validate parses and verifies a JWT token. Returns claims if valid.
func (m *JWTManager) Validate(token string) (*Claims, error) {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return nil, ErrInvalidToken
	}

	// Verify signature (constant-time comparison)
	expected := m.sign(parts[0] + "." + parts[1])
	if !hmac.Equal([]byte(parts[2]), []byte(expected)) {
		return nil, ErrInvalidToken
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("auth: decode payload: %w", err)
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("auth: parse claims: %w", err)
	}

	if time.Now().Unix() > claims.Exp {
		return nil, ErrTokenExpired
	}

	return &claims, nil
}

// Expiry returns the configured token expiry duration.
func (m *JWTManager) Expiry() time.Duration {
	return m.expiry
}

func (m *JWTManager) sign(data string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte(data))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func b64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func mustJSON(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}
