package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	enrollmentProofTimestampHeader = "X-BD-Enrollment-Timestamp"
	enrollmentProofNonceHeader     = "X-BD-Enrollment-Nonce"
	enrollmentProofSignatureHeader = "X-BD-Enrollment-Signature"
)

// enrollmentIdentity deterministically derives an Ed25519 key from the
// installation secret, which is encrypted in the local state file. This gives
// an installation a stable proof-of-possession identity without placing a
// second private-key file next to the binary.
func enrollmentIdentity(st *AppState) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if st == nil {
		return nil, nil, fmt.Errorf("enrollment state is required")
	}
	st.mu.Lock()
	secret := st.InstallationSecret
	st.mu.Unlock()
	if secret == "" {
		return nil, nil, fmt.Errorf("installation secret is unavailable")
	}
	decoded, err := hex.DecodeString(secret)
	if err != nil {
		return nil, nil, fmt.Errorf("decode installation secret: %w", err)
	}
	seedMaterial := append([]byte("betterdesk-support-enrollment-ed25519-v1|"), decoded...)
	seed := sha256.Sum256(seedMaterial)
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	return privateKey.Public().(ed25519.PublicKey), privateKey, nil
}

func enrollmentPublicKey(st *AppState) (string, error) {
	publicKey, _, err := enrollmentIdentity(st)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(publicKey), nil
}

// enrollmentProofHeaders signs the method and path of an enrollment request.
// The signature is intentionally scoped to this endpoint and includes a
// timestamp and nonce so it cannot be reused as a management-channel proof.
func enrollmentProofHeaders(method, rawURL, deviceID string, st *AppState) (http.Header, error) {
	if strings.TrimSpace(deviceID) == "" {
		return nil, fmt.Errorf("device id is required for enrollment proof")
	}
	publicKey, privateKey, err := enrollmentIdentity(st)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Path == "" {
		return nil, fmt.Errorf("parse enrollment URL: %w", err)
	}
	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return nil, fmt.Errorf("generate enrollment nonce: %w", err)
	}
	timestamp := time.Now().UTC().Format(time.RFC3339)
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	canonicalPublicKey := base64.StdEncoding.EncodeToString(publicKey)
	payload := fmt.Sprintf(
		"bd-enrollment-v1\n%s\n%s\n%s\n%s\n%s\n%s",
		strings.ToUpper(strings.TrimSpace(method)),
		parsed.EscapedPath(),
		strings.TrimSpace(deviceID),
		canonicalPublicKey,
		timestamp,
		nonce,
	)
	signature := ed25519.Sign(privateKey, []byte(payload))
	headers := make(http.Header)
	headers.Set(enrollmentProofTimestampHeader, timestamp)
	headers.Set(enrollmentProofNonceHeader, nonce)
	headers.Set(enrollmentProofSignatureHeader, base64.StdEncoding.EncodeToString(signature))

	// A device may use the current token to migrate a legacy enrollment that
	// predates the public-key binding. It is sent in a header rather than a URL.
	if _, token, _ := st.EnrollmentSnapshot(); token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
	return headers, nil
}

// apiJSONWithHeaders is the enrollment-only form of apiJSON. It shares the
// hardened HTTP client while allowing proof-of-possession request headers.
func apiJSONWithHeaders(method, apiURL string, body any, headers http.Header, out any) (int, error) {
	if err := validateAPIEndpoint(apiURL); err != nil {
		return 0, err
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, method, apiURL, reader)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}

	resp, err := apiHTTPClient(22 * time.Second).Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, fmt.Errorf("invalid JSON: %w", err)
		}
	}
	return resp.StatusCode, nil
}
