package main

import (
	"fmt"
	"net/http"
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
	url := apiBaseURL(b) + "/devices/self/access-policy"
	code, err := apiJSON(http.MethodPost, url, payload, nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent {
		return fmt.Errorf("access policy sync failed (HTTP %d)", code)
	}
	return nil
}
