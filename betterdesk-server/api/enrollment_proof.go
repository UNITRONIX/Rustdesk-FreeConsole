package api

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

const (
	enrollmentProofClockSkew = 5 * time.Minute
	enrollmentProofNonceMax  = 256
)

type enrollmentProofVerifiedKey struct{}

var enrollmentProofNonceCache = &bdMgmtNonceCache{items: make(map[string]time.Time)}

// withEnrollmentProofVerified marks that this request already consumed a valid
// enrollment proof for deviceID. Later token-issue authorization must not
// verify the same nonce again (that would look like a replay).
func withEnrollmentProofVerified(r *http.Request, deviceID string) *http.Request {
	if r == nil {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), enrollmentProofVerifiedKey{}, strings.TrimSpace(deviceID)))
}

func enrollmentProofAlreadyVerified(r *http.Request, deviceID string) bool {
	if r == nil {
		return false
	}
	verified, _ := r.Context().Value(enrollmentProofVerifiedKey{}).(string)
	return verified != "" && verified == strings.TrimSpace(deviceID)
}

// enrollmentProofPayload is deliberately distinct from the management-channel
// signature format. A valid management proof must not be replayable to mint a
// device token, and vice versa.
func enrollmentProofPayload(method, path, deviceID, publicKey, timestamp, nonce string) []byte {
	return fmt.Appendf(nil,
		"bd-enrollment-v1\n%s\n%s\n%s\n%s\n%s\n%s",
		method, path, deviceID, publicKey, timestamp, nonce,
	)
}

// verifyEnrollmentDeviceProof verifies a short-lived proof of possession for
// the device identity. Existing peers must use their already-bound key; an
// untrusted request cannot replace that key. A first registration may prove
// possession of the public_key it is binding, which is sufficient in open mode
// where admission itself is intentionally unrestricted.
func (s *Server) verifyEnrollmentDeviceProof(r *http.Request, deviceID, incomingPublicKey string) error {
	timestamp := strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Timestamp"))
	nonce := strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Nonce"))
	signature := strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Signature"))
	if timestamp == "" || nonce == "" || signature == "" {
		return fmt.Errorf("missing enrollment proof headers")
	}
	if len(nonce) > enrollmentProofNonceMax {
		return fmt.Errorf("enrollment proof nonce is too long")
	}

	signedAt, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		return fmt.Errorf("invalid enrollment proof timestamp: %w", err)
	}
	now := time.Now().UTC()
	delta := now.Sub(signedAt.UTC())
	if delta < 0 {
		delta = -delta
	}
	if delta > enrollmentProofClockSkew {
		return fmt.Errorf("enrollment proof timestamp outside allowed skew")
	}

	canonicalKey, publicKey, err := s.enrollmentProofPublicKey(deviceID, incomingPublicKey)
	if err != nil {
		return err
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return fmt.Errorf("invalid enrollment proof signature encoding: %w", err)
	}
	if len(decodedSignature) != ed25519.SignatureSize {
		return fmt.Errorf("invalid enrollment proof signature length")
	}

	payload := enrollmentProofPayload(r.Method, r.URL.Path, deviceID, canonicalKey, timestamp, nonce)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), payload, decodedSignature) {
		return fmt.Errorf("invalid enrollment proof signature")
	}
	if enrollmentProofNonceCache.markUsed("enrollment:"+deviceID+":"+nonce, now) {
		return fmt.Errorf("replayed enrollment proof")
	}
	return nil
}

// enrollmentProofPublicKey returns the only key that may authenticate an
// enrollment token issuance for deviceID. Pending metadata is trusted only
// because it was captured on the initial request and is immutable afterward.
func (s *Server) enrollmentProofPublicKey(deviceID, incomingPublicKey string) (string, []byte, error) {
	if s.db == nil {
		return "", nil, fmt.Errorf("device database unavailable")
	}

	peerInfo, err := s.db.GetPeer(deviceID)
	if err != nil {
		return "", nil, fmt.Errorf("load enrolled device: %w", err)
	}
	if peerInfo != nil {
		publicKey, err := s.loadBdMgmtPublicKey(deviceID)
		if err != nil {
			return "", nil, fmt.Errorf("no bound device identity: %w", err)
		}
		canonical := base64.StdEncoding.EncodeToString(publicKey)
		if incomingPublicKey != "" {
			incomingCanonical, err := canonicalizeDevicePublicKey(incomingPublicKey)
			if err != nil {
				return "", nil, err
			}
			if incomingCanonical != canonical {
				return "", nil, fmt.Errorf("public_key does not match bound device identity")
			}
		}
		return canonical, publicKey, nil
	}

	if pending, ok := s.pendingEnrollmentForProof(deviceID); ok && pending.PublicKey != "" {
		canonical, err := canonicalizeDevicePublicKey(pending.PublicKey)
		if err != nil {
			return "", nil, fmt.Errorf("invalid pending device public key: %w", err)
		}
		if incomingPublicKey != "" {
			incomingCanonical, err := canonicalizeDevicePublicKey(incomingPublicKey)
			if err != nil {
				return "", nil, err
			}
			if incomingCanonical != canonical {
				return "", nil, fmt.Errorf("public_key does not match pending device identity")
			}
		}
		publicKey, err := base64.StdEncoding.DecodeString(canonical)
		if err != nil {
			return "", nil, err
		}
		return canonical, publicKey, nil
	}

	canonical, err := canonicalizeDevicePublicKey(incomingPublicKey)
	if err != nil {
		return "", nil, fmt.Errorf("public_key required for initial enrollment proof: %w", err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(canonical)
	if err != nil {
		return "", nil, err
	}
	return canonical, publicKey, nil
}

func (s *Server) pendingEnrollmentForProof(deviceID string) (pendingDeviceInfo, bool) {
	var pending pendingDeviceInfo
	raw, err := s.db.GetConfig(pendingDevicePrefix + deviceID)
	if err != nil || raw == "" {
		return pending, false
	}
	if err := json.Unmarshal([]byte(raw), &pending); err != nil || pending.DeviceID == "" {
		return pendingDeviceInfo{}, false
	}
	return pending, true
}

// enrollmentTokenCandidates reads credentials only from a POST body field or
// the standard Authorization header. Tokens are intentionally never accepted
// from query parameters, which are commonly retained by access logs and
// intermediaries.
func enrollmentTokenCandidates(r *http.Request, bodyToken string) []string {
	candidates := make([]string, 0, 2)
	if token := strings.TrimSpace(bodyToken); token != "" {
		candidates = append(candidates, token)
	}
	if authorization := r.Header.Get("Authorization"); len(authorization) > len("Bearer ") &&
		strings.EqualFold(authorization[:len("Bearer ")], "Bearer ") {
		if token := strings.TrimSpace(authorization[len("Bearer "):]); token != "" {
			candidates = append(candidates, token)
		}
	}
	return candidates
}

// enrollmentProofProvided distinguishes a legacy credential-only request from
// a request that attempted proof-of-possession. The latter must not fall back
// to the bearer credential after an invalid or replayed proof: otherwise a
// captured request could mint another token despite nonce replay protection.
func enrollmentProofProvided(r *http.Request) bool {
	if r == nil {
		return false
	}
	return strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Timestamp")) != "" ||
		strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Nonce")) != "" ||
		strings.TrimSpace(r.Header.Get("X-BD-Enrollment-Signature")) != ""
}

// hasEnrollmentCredential accepts a valid device/enrollment token only when
// it is either unbound (for first enrollment) or bound to the exact device.
// Reissuance always requires an active, device-bound credential.
func (s *Server) hasEnrollmentCredential(deviceID string, candidates []string, requireBound bool) bool {
	for _, candidate := range candidates {
		token, err := s.db.ValidateToken(hashToken(candidate))
		if err != nil || token == nil {
			continue
		}
		if requireBound {
			if token.Status == db.TokenStatusActive && token.PeerID == deviceID {
				return true
			}
			continue
		}
		if token.PeerID == "" || token.PeerID == deviceID {
			return true
		}
	}
	return false
}

// authorizeEnrollmentTokenIssue requires a credential that is already tied to
// the device, or a replay-protected proof made by that device's private key.
func (s *Server) authorizeEnrollmentTokenIssue(r *http.Request, deviceID, publicKey, bodyToken string, requireBoundToken bool) bool {
	if r == nil {
		return false
	}
	if enrollmentProofAlreadyVerified(r, deviceID) {
		return true
	}
	if enrollmentProofProvided(r) {
		// Do not fall back to a valid bearer token here. A replayed proof must
		// be rejected rather than bypassing the nonce cache through Authorization.
		return s.verifyEnrollmentDeviceProof(r, deviceID, publicKey) == nil
	}
	if s.hasEnrollmentCredential(deviceID, enrollmentTokenCandidates(r, bodyToken), requireBoundToken) {
		return true
	}
	return false
}
