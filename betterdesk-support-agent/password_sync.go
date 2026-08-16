package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SyncAccessPassword publishes only the local password-policy state. The
// unattended secret is deliberately verified by the Support Agent and never
// sent to, stored by, or logged by the server.
func SyncAccessPassword(b Branding, st *AppState) error {
	deviceID, _, _, _ := st.Snapshot()
	st.mu.Lock()
	token := st.DeviceToken
	st.mu.Unlock()

	if token == "" {
		return fmt.Errorf("device not enrolled")
	}
	policy := accessPolicyFor(b, st)

	payload := map[string]any{
		"device_id":          deviceID,
		"device_token":       token,
		"password_set":       policy.passwordConfigured,
		"unattended_enabled": policy.allowsUnattended(),
	}
	endpoint := apiBaseURL(b) + "/devices/self/access-policy"
	code, err := apiJSON(http.MethodPost, endpoint, payload, nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent {
		return fmt.Errorf("access policy sync failed (HTTP %d)", code)
	}
	return nil
}

// PullAccessPolicy fetches console-desired unattended settings and applies
// them locally when the server has a sealed password (admin Access Policy).
func PullAccessPolicy(b Branding, st *AppState) error {
	deviceID, _, localPassword, _ := st.Snapshot()
	st.mu.Lock()
	token := st.DeviceToken
	st.mu.Unlock()
	if token == "" || deviceID == "" {
		return fmt.Errorf("device not enrolled")
	}

	q := url.Values{}
	q.Set("device_id", deviceID)
	q.Set("device_token", token)
	endpoint := apiBaseURL(b) + "/devices/self/access-policy?" + q.Encode()

	var resp struct {
		UnattendedEnabled bool   `json:"unattended_enabled"`
		Password          string `json:"password"`
		PasswordSet       bool   `json:"password_set"`
		UpdatedBy         string `json:"updated_by"`
	}
	code, err := apiJSON(http.MethodGet, endpoint, nil, &resp)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("access policy pull failed (HTTP %d)", code)
	}

	// Only apply passwords originating from the console (not our own push).
	updatedBy := strings.TrimSpace(resp.UpdatedBy)
	if strings.HasPrefix(updatedBy, "device:") {
		return nil
	}
	if resp.Password == "" {
		return nil
	}
	if resp.Password == localPassword {
		wantMode := AccessSupervised
		if resp.UnattendedEnabled {
			wantMode = AccessUnattended
		}
		_, mode, _, _ := st.Snapshot()
		if mode != wantMode {
			return st.SetAccessMode(wantMode)
		}
		return nil
	}

	if err := st.SetCustomPassword(resp.Password); err != nil {
		return err
	}
	wantMode := AccessSupervised
	if resp.UnattendedEnabled {
		wantMode = AccessUnattended
	}
	return st.SetAccessMode(wantMode)
}

func startAccessPolicyPullLoop(b Branding, st *AppState) {
	// Pull promptly after console Access Policy changes so RdClient auto-auth
	// does not race a stale local permanent password ("Wrong Password").
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		_ = PullAccessPolicy(b, st)
		_ = SyncAccessPassword(b, st)
	}
}
