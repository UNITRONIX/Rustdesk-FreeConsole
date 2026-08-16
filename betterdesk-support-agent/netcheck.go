package main

import (
	"context"
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

type ExtendedConnCheck struct {
	CDAP       ProbeResult
	API        ProbeResult
	Enrollment ProbeResult
}

func (c ConnCheck) AllOK() bool {
	return c.CDAP.OK && c.API.OK
}

func (c ExtendedConnCheck) AllOK() bool {
	return c.CDAP.OK && c.API.OK && c.Enrollment.OK
}

// TestConnection probes the CDAP gateway and the Go management API.
func TestConnection(b Branding) ConnCheck {
	return ConnCheck{
		CDAP: probeHealth(b.CDAPHealthURL()),
		API:  probeHealth(b.APIHealthURL()),
	}
}

// TestConnectionExtended includes enrollment reachability for the device API
// and prefers last-known-good endpoints when available.
func TestConnectionExtended(b Branding, st *AppState) ExtendedConnCheck {
	_, cdapProbe := PickWorkingCDAP(b, st)
	apiBase, apiProbe := PickWorkingAPI(b, st)
	res := ExtendedConnCheck{
		CDAP: cdapProbe,
		API:  apiProbe,
	}
	if !b.HasConnection() {
		res.Enrollment = ProbeResult{OK: false, Detail: "no server configured"}
		return res
	}
	deviceID, _, _, _ := st.Snapshot()
	url := fmt.Sprintf("%s/devices/register/status?device_id=%s", apiBase, deviceID)
	_, latency, err := httpGet(url)
	if err != nil {
		// Fallback to branded API base if last-good drifted.
		url = fmt.Sprintf("%s/devices/register/status?device_id=%s", apiBaseURL(b), deviceID)
		_, latency, err = httpGet(url)
	}
	if err != nil {
		res.Enrollment = ProbeResult{OK: false, Detail: shortenErr(err.Error()), Latency: latency}
		return res
	}
	res.Enrollment = ProbeResult{OK: true, Detail: "register API reachable", Latency: latency}
	return res
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

	client := healthHTTPClient(endpoint)

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

func healthHTTPClient(endpoint string) *http.Client {
	if !strings.HasPrefix(strings.ToLower(endpoint), "https://") {
		return &http.Client{Timeout: 8 * time.Second}
	}
	pin := ""
	if b := GetBranding(); b.Server != nil {
		pin = b.Server.CertPin
	}
	return apiHTTPClientWithPin(8*time.Second, pin)
}
