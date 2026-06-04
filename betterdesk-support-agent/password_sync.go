package main

import (
	"fmt"
	"net/http"
)

// SyncAccessPassword pushes the local access password to the server so
// operators can connect in unattended mode via rdclient/rustdesk.
func SyncAccessPassword(b Branding, st *AppState) error {
	deviceID, mode, password, _ := st.Snapshot()
	st.mu.Lock()
	token := st.DeviceToken
	st.mu.Unlock()

	if token == "" {
		return fmt.Errorf("device not enrolled")
	}

	payload := map[string]any{
		"device_id":          deviceID,
		"device_token":       token,
		"password":           password,
		"unattended_enabled": mode == AccessUnattended,
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
