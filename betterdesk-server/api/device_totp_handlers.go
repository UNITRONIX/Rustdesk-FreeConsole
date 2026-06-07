package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/auth"
)

type deviceTOTPStatus struct {
	Enabled bool   `json:"enabled"`
	URI     string `json:"otpauth_uri,omitempty"`
	Secret  string `json:"secret,omitempty"`
}

func deviceTokenPeerID(s *Server, deviceID, token string) (string, bool) {
	if deviceID == "" || token == "" {
		return "", false
	}
	dt, err := s.db.ValidateToken(hashToken(token))
	if err != nil || dt == nil {
		return "", false
	}
	if dt.PeerID != "" && dt.PeerID != deviceID {
		return "", false
	}
	return deviceID, true
}

// GET/POST /api/devices/self/totp
func (s *Server) handleDeviceSelfTOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID    string `json:"device_id"`
		DeviceToken string `json:"device_token"`
		Action      string `json:"action"`
		Code        string `json:"code"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
	}
	if body.DeviceID == "" {
		body.DeviceID = r.URL.Query().Get("device_id")
	}
	if body.DeviceToken == "" {
		body.DeviceToken = r.URL.Query().Get("device_token")
	}
	if _, ok := deviceTokenPeerID(s, body.DeviceID, body.DeviceToken); !ok {
		http.Error(w, "invalid device token", http.StatusForbidden)
		return
	}

	enabledKey := "device_totp_enabled_" + body.DeviceID
	secretKey := "device_totp_secret_" + body.DeviceID

	if r.Method == http.MethodGet {
		enabled, _ := s.db.GetConfig(enabledKey)
		resp := deviceTOTPStatus{Enabled: enabled == "true"}
		writeDeviceJSON(w, resp)
		return
	}

	switch strings.ToLower(strings.TrimSpace(body.Action)) {
	case "setup":
		secret := auth.GenerateTOTPSecret()
		_ = s.db.SetConfig(secretKey, secret)
		uri := auth.TOTPUri(secret, "BetterDesk", body.DeviceID)
		writeDeviceJSON(w, deviceTOTPStatus{Secret: secret, URI: uri})
	case "enable":
		secret, _ := s.db.GetConfig(secretKey)
		if secret == "" || !auth.ValidateTOTP(secret, body.Code) {
			http.Error(w, "invalid code", http.StatusBadRequest)
			return
		}
		_ = s.db.SetConfig(enabledKey, "true")
		writeDeviceJSON(w, deviceTOTPStatus{Enabled: true})
	case "disable":
		secret, _ := s.db.GetConfig(secretKey)
		if secret != "" && !auth.ValidateTOTP(secret, body.Code) {
			http.Error(w, "invalid code", http.StatusBadRequest)
			return
		}
		_ = s.db.SetConfig(enabledKey, "false")
		_ = s.db.SetConfig(secretKey, "")
		writeDeviceJSON(w, deviceTOTPStatus{Enabled: false})
	default:
		enabled, _ := s.db.GetConfig(enabledKey)
		writeDeviceJSON(w, deviceTOTPStatus{Enabled: enabled == "true"})
	}
}

func writeDeviceJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
