package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Connection self-test.
//
// The agent can independently verify that it can reach the BetterDesk backend
// before a user asks for help. It probes the two public health endpoints the
// server exposes:
//
//   - CDAP gateway   GET {scheme}://host:21122/cdap/health  (remote sessions)
//   - Web console    GET {scheme}://host:5000/health        (help requests)
//
// Both checks are unauthenticated and side-effect free, so they are safe to run
// on demand from the UI.

// ProbeResult is the outcome of a single endpoint probe.
type ProbeResult struct {
	OK      bool
	Detail  string // short human-readable status (i18n-free, technical)
	Latency time.Duration
}

// ConnCheck aggregates the self-test results.
type ConnCheck struct {
	CDAP    ProbeResult
	Console ProbeResult
}

// AllOK reports whether both probes succeeded.
func (c ConnCheck) AllOK() bool { return c.CDAP.OK && c.Console.OK }

// TestConnection probes the CDAP gateway and the web console health endpoints.
// It always returns a populated ConnCheck; failures are recorded per-probe.
func TestConnection(b Branding) ConnCheck {
	return ConnCheck{
		CDAP:    probeCDAP(b.ServerAddress),
		Console: probeConsole(b.ServerAddress),
	}
}

// probeCDAP checks the CDAP gateway /cdap/health endpoint and validates the
// JSON status field.
func probeCDAP(addr string) ProbeResult {
	scheme := "http"
	if os.Getenv("BETTERDESK_CDAP_TLS") == "1" {
		scheme = "https"
	}
	endpoint := fmt.Sprintf("%s://%s:%d/cdap/health", scheme, hostFromAddr(addr), 21122)

	body, latency, err := httpGet(endpoint)
	if err != nil {
		return ProbeResult{OK: false, Detail: err.Error(), Latency: latency}
	}
	var parsed struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Status == "ok" {
		return ProbeResult{OK: true, Detail: "gateway ok", Latency: latency}
	}
	return ProbeResult{OK: false, Detail: "unexpected gateway response", Latency: latency}
}

// probeConsole checks the web console /health endpoint.
func probeConsole(addr string) ProbeResult {
	scheme := schemeFromAddr(addr)
	endpoint := fmt.Sprintf("%s://%s:%d/health", scheme, hostFromAddr(addr), consolePort)

	_, latency, err := httpGet(endpoint)
	if err != nil {
		return ProbeResult{OK: false, Detail: err.Error(), Latency: latency}
	}
	return ProbeResult{OK: true, Detail: "console ok", Latency: latency}
}

// httpGet performs a short GET and returns the body, latency and error.
func httpGet(endpoint string) ([]byte, time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}

	client := &http.Client{Timeout: 8 * time.Second}
	if os.Getenv("BETTERDESK_AGENT_INSECURE_TLS") == "1" {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // opt-in for self-signed test servers
		}
	}

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return nil, latency, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, latency, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for {
		n, rerr := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if rerr != nil || len(buf) > 4096 {
			break
		}
	}
	return buf, latency, nil
}

// hostFromAddr extracts the bare host from a branding server address.
func hostFromAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	withScheme := addr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		withScheme = "http://" + addr
	}
	if u, err := url.Parse(withScheme); err == nil && u.Hostname() != "" {
		host := u.Hostname()
		if strings.Contains(host, ":") {
			return "[" + host + "]"
		}
		return host
	}
	if addr == "" {
		return "localhost"
	}
	return addr
}

// schemeFromAddr returns "https" when the branding address is explicitly
// https, otherwise "http".
func schemeFromAddr(addr string) string {
	if strings.HasPrefix(strings.TrimSpace(addr), "https://") {
		return "https"
	}
	return "http"
}
