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

type ProbeResult struct {
	OK      bool
	Detail  string
	Latency time.Duration
}

type ConnCheck struct {
	CDAP ProbeResult
	API  ProbeResult
}

func (c ConnCheck) AllOK() bool {
	return c.CDAP.OK && c.API.OK
}

// TestConnection probes the CDAP gateway and the Go management API.
func TestConnection(b Branding) ConnCheck {
	return ConnCheck{
		CDAP: probeHealth(b.CDAPHealthURL()),
		API:  probeHealth(b.APIHealthURL()),
	}
}

func probeHealth(endpoint string) ProbeResult {
	body, latency, err := httpGet(endpoint)
	if err != nil {
		return ProbeResult{OK: false, Detail: shortenErr(err.Error()), Latency: latency}
	}
	var parsed struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(body, &parsed) != nil || parsed.Status != "ok" {
		return ProbeResult{OK: false, Detail: "unexpected response", Latency: latency}
	}
	detail := "ok"
	if strings.Contains(endpoint, "/cdap/health") {
		detail = "gateway ok"
	} else if strings.Contains(endpoint, "/api/health") {
		detail = "api ok"
	}
	return ProbeResult{OK: true, Detail: detail, Latency: latency}
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
	if strings.HasPrefix(endpoint, "https://") {
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
