package main

import (
	"net/url"
	"strings"
	"time"
)

// RememberGoodEndpoints persists the last-known-good CDAP and API base URLs
// so the next start prefers a working path after operator config churn.
func (st *AppState) RememberGoodEndpoints(cdapWS, apiBase string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	changed := false
	if u := strings.TrimSpace(cdapWS); u != "" && u != st.LastGoodCDAP {
		st.LastGoodCDAP = u
		changed = true
	}
	if u := strings.TrimSpace(apiBase); u != "" && u != st.LastGoodAPI {
		st.LastGoodAPI = u
		changed = true
	}
	if changed {
		st.LastGoodAt = time.Now().UTC().Format(time.RFC3339)
		_ = st.save()
	}
}

func (st *AppState) LastGood() (cdapWS, apiBase string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.LastGoodCDAP, st.LastGoodAPI
}

// CandidateCDAPWebSockets returns CDAP WS URLs to try, last-good first.
func CandidateCDAPWebSockets(b Branding, st *AppState) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimRight(strings.TrimSpace(u), "/")
		if u == "" || seen[u] || !b.allowsEndpoint(u) {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	if st != nil {
		last, _ := st.LastGood()
		add(last)
	}
	add(b.CDAPWebSocketURL())
	if b.Server != nil {
		add(strings.TrimSpace(b.Server.CDAPURL))
	}
	// A local developer may deliberately test a scheme change. Distributed
	// profiles never derive a plaintext fallback from a signed WSS endpoint.
	if !isReleaseBuild() {
		primary := b.CDAPWebSocketURL()
		if strings.HasPrefix(primary, "wss://") {
			add("ws://" + strings.TrimPrefix(primary, "wss://"))
		} else if strings.HasPrefix(primary, "ws://") {
			add("wss://" + strings.TrimPrefix(primary, "ws://"))
		}
	}
	return out
}

// CandidateAPIBases returns API base URLs to try, last-good first.
func CandidateAPIBases(b Branding, st *AppState) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimRight(strings.TrimSpace(u), "/")
		if u == "" || seen[u] || !b.allowsEndpoint(u) {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	if st != nil {
		_, last := st.LastGood()
		add(last)
	}
	add(apiBaseURL(b))
	if b.Server != nil {
		add(strings.TrimSpace(b.Server.APIURL))
	}
	return out
}

func (b Branding) allowsEndpoint(endpoint string) bool {
	if !isReleaseBuild() {
		return true
	}
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if !isAllowedTransportEndpoint(endpoint) {
		return false
	}
	for _, allowed := range b.AllowedEndpoints {
		if endpoint == strings.TrimRight(strings.TrimSpace(allowed), "/") {
			return true
		}
	}
	return false
}

// healthURLFromCDAPWS converts a CDAP websocket URL to its /cdap/health HTTP twin.
func healthURLFromCDAPWS(ws string) string {
	ws = strings.TrimSpace(ws)
	if ws == "" {
		return ""
	}
	u := strings.Replace(ws, "wss://", "https://", 1)
	u = strings.Replace(u, "ws://", "http://", 1)
	u = strings.TrimRight(u, "/")
	if strings.HasSuffix(u, "/cdap") {
		return u + "/health"
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return u + "/cdap/health"
	}
	parsed.Path = "/cdap/health"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

// PickWorkingCDAP probes candidates and returns the first healthy WS URL.
func PickWorkingCDAP(b Branding, st *AppState) (string, ProbeResult) {
	for _, ws := range CandidateCDAPWebSockets(b, st) {
		health := healthURLFromCDAPWS(ws)
		pr := probeHealth(health)
		if pr.OK {
			if st != nil {
				st.RememberGoodEndpoints(ws, "")
			}
			return ws, pr
		}
	}
	// Fall back to branded default even if unhealthy — engine will reconnect.
	return b.CDAPWebSocketURL(), ProbeResult{OK: false, Detail: "no healthy CDAP endpoint"}
}

// PickWorkingAPI probes candidate API bases.
func PickWorkingAPI(b Branding, st *AppState) (string, ProbeResult) {
	for _, base := range CandidateAPIBases(b, st) {
		pr := probeHealth(strings.TrimRight(base, "/") + "/health")
		if pr.OK {
			if st != nil {
				st.RememberGoodEndpoints("", base)
			}
			return base, pr
		}
	}
	return apiBaseURL(b), ProbeResult{OK: false, Detail: "no healthy API endpoint"}
}
