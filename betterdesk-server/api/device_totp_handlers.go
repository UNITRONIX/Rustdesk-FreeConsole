package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

type deviceTOTPStatus struct {
	Enabled bool   `json:"enabled"`
	URI     string `json:"otpauth_uri,omitempty"`
	Secret  string `json:"secret,omitempty"`
}

// hasBoundActiveDeviceToken verifies a credential used by a device self-service
// endpoint. Enrollment tokens are intentionally allowed to be unbound while a
// device is enrolling, but they must never authorize actions as an enrolled
// device before they are active and tied to that exact peer.
func (s *Server) hasBoundActiveDeviceToken(deviceID, token string) bool {
	if s.db == nil || deviceID == "" || token == "" {
		return false
	}
	dt, err := s.db.ValidateToken(hashToken(token))
	if err != nil || dt == nil || dt.Status != db.TokenStatusActive || dt.PeerID != deviceID {
		return false
	}
	peer, err := s.db.GetPeer(deviceID)
	return err == nil && peer != nil && !peer.Banned && !peer.SoftDeleted
}

func deviceTokenPeerID(s *Server, deviceID, token string) (string, bool) {
	if !s.hasBoundActiveDeviceToken(deviceID, token) {
		return "", false
	}
	return deviceID, true
}

// POST /api/devices/self/totp
//
// Device credentials and TOTP codes are accepted only in the JSON body. Query
// parameters are routinely captured by proxies, browser history, and logs.
func (s *Server) handleDeviceSelfTOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID    string `json:"device_id"`
		DeviceToken string `json:"device_token"`
		Action      string `json:"action"`
		Code        string `json:"code"`
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if _, ok := deviceTokenPeerID(s, body.DeviceID, body.DeviceToken); !ok {
		http.Error(w, "invalid device token", http.StatusForbidden)
		return
	}

	enabledKey := "device_totp_enabled_" + body.DeviceID
	secretKey := "device_totp_secret_" + body.DeviceID

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
