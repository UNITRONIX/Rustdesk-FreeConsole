package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const defaultAPIPort = 21114

func tlsInsecureEnabled() bool {
	// A release binary must never allow an environment variable to downgrade
	// certificate verification. Development builds may opt in for local
	// self-signed test servers only.
	return !isReleaseBuild() && os.Getenv("BETTERDESK_AGENT_INSECURE_TLS") == "1"
}

// apiHTTPClient returns an HTTP client for BetterDesk API calls.
func apiHTTPClient(timeout time.Duration) *http.Client {
	pin := ""
	if b := GetBranding(); b.Server != nil {
		pin = b.Server.CertPin
	}
	return apiHTTPClientWithPin(timeout, pin)
}

func apiHTTPClientWithPin(timeout time.Duration, pin string) *http.Client {
	client := &http.Client{Timeout: timeout}
	pin = normalizeServerCertPin(pin)
	if pin == "" && !tlsInsecureEnabled() {
		return client
	}

	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if pin != "" {
		// Pinning the leaf SPKI is an authentication check stronger than
		// platform trust alone. The profile's endpoint allowlist prevents this
		// key from being used for an arbitrary destination.
		tlsConfig.InsecureSkipVerify = true //nolint:gosec // verified below
		tlsConfig.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("tls: server presented no certificate")
			}
			leaf, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return fmt.Errorf("tls: parse leaf certificate: %w", err)
			}
			sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
			got := hex.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(got), []byte(pin)) != 1 {
				return fmt.Errorf("tls: server public-key pin mismatch")
			}
			return nil
		}
	} else {
		// Development-only self-signed test mode. tlsInsecureEnabled() cannot
		// become true in a release build.
		tlsConfig.InsecureSkipVerify = true //nolint:gosec // opt-in development mode
	}
	client.Transport = &http.Transport{TLSClientConfig: tlsConfig}
	return client
}

func normalizeServerCertPin(pin string) string {
	pin = strings.ToLower(strings.TrimSpace(pin))
	pin = strings.NewReplacer("sha256:", "", ":", "", " ", "", "\t", "", "\n", "").Replace(pin)
	if len(pin) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(pin); err != nil {
		return ""
	}
	return pin
}

// apiBaseURL resolves the Go server API base (…/api) from branding.
func apiBaseURL(b Branding) string {
	if b.Server != nil && strings.TrimSpace(b.Server.APIURL) != "" {
		u := strings.TrimRight(strings.TrimSpace(b.Server.APIURL), "/")
		if strings.HasSuffix(u, "/api") {
			return u
		}
		return u + "/api"
	}
	scheme := schemeFromAddr(b.ServerAddress)
	if b.useTLS() {
		scheme = "https"
	}
	host := hostFromAddr(b.ServerAddress)
	return fmt.Sprintf("%s://%s:%d/api", scheme, host, defaultAPIPort)
}

// apiJSON performs a JSON HTTP request against the BetterDesk API.
func apiJSON(method, apiURL string, body any, out any) (int, error) {
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

	resp, err := apiHTTPClient(22 * time.Second).Do(req)
	if err != nil {
		// #region agent log
		debugLog("H2", "apihttp.go:apiJSON", "http request failed", map[string]any{
			"method": method, "url": apiURL, "error": err.Error(),
			"insecure_tls": tlsInsecureEnabled(),
		})
		// #endregion
		return 0, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			// #region agent log
			debugLog("H2", "apihttp.go:apiJSON", "json decode failed", map[string]any{
				"method": method, "url": apiURL, "status": resp.StatusCode,
				"body_len": len(raw), "error": err.Error(),
			})
			// #endregion
			return resp.StatusCode, fmt.Errorf("invalid JSON: %w", err)
		}
	}
	if resp.StatusCode >= 400 {
		// #region agent log
		debugLog("H2", "apihttp.go:apiJSON", "http error status", map[string]any{
			"method": method, "url": apiURL, "status": resp.StatusCode, "body_len": len(raw),
		})
		// #endregion
	}
	return resp.StatusCode, nil
}

func validateAPIEndpoint(apiURL string) error {
	u, err := url.Parse(apiURL)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid BetterDesk API endpoint")
	}
	if isReleaseBuild() && !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("release build refuses non-HTTPS BetterDesk API endpoint")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported BetterDesk API endpoint scheme")
	}
	return nil
}

// normalizeServerOrigin stores a canonical https?://host:port origin in branding address.
func normalizeServerOrigin(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return addr
	}
	withScheme := addr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		withScheme = "http://" + addr
	}
	u, err := url.Parse(withScheme)
	if err != nil || u.Host == "" {
		return addr
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("%s://%s:%s", u.Scheme, host, port)
}
