package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// TestConnection probes the CDAP gateway and the web console health endpoints.
func TestConnection(b Branding) ConnCheck {
	return ConnCheck{
		CDAP:    probeHealth(b.CDAPHealthURL()),
		Console: probeHealth(b.ConsoleHealthURL()),
	}
}

func probeHealth(endpoint string) ProbeResult {
	body, latency, err := httpGet(endpoint)
	if err != nil {
		return ProbeResult{OK: false, Detail: shortenErr(err.Error()), Latency: latency}
	}
	if strings.Contains(endpoint, "/cdap/health") {
		var parsed struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(body, &parsed) == nil && parsed.Status == "ok" {
			return ProbeResult{OK: true, Detail: "gateway ok", Latency: latency}
		}
		return ProbeResult{OK: false, Detail: "unexpected gateway response", Latency: latency}
	}
	return ProbeResult{OK: true, Detail: "console ok", Latency: latency}
}

func shortenErr(msg string) string {
	msg = strings.TrimSpace(msg)
	if len(msg) <= 120 {
		return msg
	}
	return msg[:117] + "…"
}

func httpGet(endpoint string) ([]byte, time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}

	client := &http.Client{Timeout: 8 * time.Second}
	if strings.HasPrefix(endpoint, "https://") || tlsInsecureEnabled() {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: tlsInsecureEnabled()}, //nolint:gosec
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
