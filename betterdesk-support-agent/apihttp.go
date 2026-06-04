package main

import (
	"bytes"
	"context"
	"crypto/tls"
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
	return os.Getenv("BETTERDESK_AGENT_INSECURE_TLS") == "1"
}

// apiHTTPClient returns an HTTP client for BetterDesk API calls.
func apiHTTPClient(timeout time.Duration) *http.Client {
	client := &http.Client{Timeout: timeout}
	if tlsInsecureEnabled() {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // opt-in dev
		}
	}
	return client
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
