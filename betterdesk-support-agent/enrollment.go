package main

import (
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	EnrollmentApproved = "approved"
	EnrollmentPending  = "pending"
	EnrollmentRejected = "rejected"
)

// enrollmentResponse mirrors betterdesk-server/api/branding_handlers.go.
type enrollmentResponse struct {
	Status            string `json:"status"`
	DeviceID          string `json:"device_id"`
	DeviceToken       string `json:"device_token,omitempty"`
	Message           string `json:"message,omitempty"`
	Error             string `json:"error,omitempty"`
	SuggestedDeviceID string `json:"suggested_device_id,omitempty"`
}

// EnrollmentStatus is the outcome of register or poll.
type EnrollmentStatus struct {
	Status      string
	DeviceID    string
	DeviceToken string
	Message     string
}

// EnsureEnrolled registers the device when needed and returns the current status.
// When already approved with a token, returns immediately.
func EnsureEnrolled(b Branding, st *AppState, version string) (EnrollmentStatus, error) {
	if !b.HasConnection() {
		// #region agent log
		debugLog("H5", "enrollment.go:EnsureEnrolled", "no connection in branding", map[string]any{
			"server_address": b.ServerAddress, "has_server_block": b.Server != nil,
		})
		// #endregion
		return EnrollmentStatus{}, fmt.Errorf("no server address configured")
	}

	st.mu.Lock()
	status := st.EnrollmentStatus
	token := st.DeviceToken
	deviceID := st.DeviceID
	st.mu.Unlock()

	// #region agent log
	debugLog("H4", "enrollment.go:EnsureEnrolled", "entry", map[string]any{
		"local_status": status, "device_id": deviceID,
		"has_local_token": token != "", "is_enrolled": st.IsEnrolled(),
	})
	// #endregion

	if status == EnrollmentApproved {
		if token != "" {
			// Refresh credentials with the server on every startup. Re-register
			// re-issues a device_token for known peers and fixes stale local state.
			if res, err := RegisterDevice(b, st, version); err == nil {
				return res, nil
			}
			// #region agent log
			debugLog("H4", "enrollment.go:EnsureEnrolled", "refresh failed, using cached token", map[string]any{
				"device_id": deviceID,
			})
			// #endregion
			return EnrollmentStatus{
				Status:      EnrollmentApproved,
				DeviceID:    deviceID,
				DeviceToken: token,
			}, nil
		}
		return RegisterDevice(b, st, version)
	}

	if status == EnrollmentRejected {
		return EnrollmentStatus{
			Status:   EnrollmentRejected,
			DeviceID: deviceID,
			Message:  st.EnrollmentMessage,
		}, nil
	}

	if status == EnrollmentPending && deviceID != "" {
		return PollEnrollment(b, st, version)
	}

	return RegisterDevice(b, st, version)
}

// RegisterDevice POSTs /api/devices/register.
func RegisterDevice(b Branding, st *AppState, version string) (EnrollmentStatus, error) {
	deviceID, _, _, _ := st.Snapshot()
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	payload := map[string]any{
		"device_id":   deviceID,
		"uuid":        st.GetMachineUUID(),
		"hostname":    hostname,
		"platform":    fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH),
		"version":     version,
		"device_type": "os_agent",
	}
	if b.BundleID != "" {
		payload["bundle_id"] = b.BundleID
	}
	// Never send a shared bundle enrollment token — each device registers
	// independently and receives a unique device_token after approval.
	tags := []string{"support-agent"}
	if IsPortable() {
		tags = append(tags, "portable")
	} else {
		tags = append(tags, "installed")
	}
	payload["tags"] = tags

	url := apiBaseURL(b) + "/devices/register"
	// #region agent log
	debugLog("H1", "enrollment.go:RegisterDevice", "register request", map[string]any{
		"url": url, "device_id": deviceID, "sends_token": false,
		"bundle_id": b.BundleID, "use_https": b.UseHTTPS,
	})
	// #endregion
	var resp enrollmentResponse
	code, err := apiJSON(http.MethodPost, url, payload, &resp)
	if err != nil {
		return EnrollmentStatus{}, err
	}
	// #region agent log
	debugLog("H2", "enrollment.go:RegisterDevice", "register response", map[string]any{
		"http_code": code, "status": resp.Status, "device_id": resp.DeviceID,
		"token_len": len(strings.TrimSpace(resp.DeviceToken)), "message": resp.Message,
	})
	// #endregion
	if code != http.StatusOK && code != http.StatusAccepted {
		if code == http.StatusConflict && resp.Error == "identity_conflict" {
			newID := strings.TrimSpace(resp.SuggestedDeviceID)
			if newID == "" {
				newID = deriveDeviceIDWithSuffix(deviceID, "-2")
			}
			if err := st.SetDeviceID(newID); err != nil {
				return EnrollmentStatus{}, err
			}
			return RegisterDevice(b, st, version)
		}
		return EnrollmentStatus{}, fmt.Errorf("registration failed (HTTP %d)", code)
	}

	result := EnrollmentStatus{
		Status:      resp.Status,
		DeviceID:    resp.DeviceID,
		DeviceToken: strings.TrimSpace(resp.DeviceToken),
		Message:     resp.Message,
	}
	if result.DeviceID == "" {
		result.DeviceID = deviceID
	}

	switch resp.Status {
	case EnrollmentApproved:
		if result.DeviceToken == "" {
			return result, fmt.Errorf("registration approved without device_token")
		}
		if err := st.SetEnrollment(EnrollmentApproved, result.DeviceID, result.DeviceToken, ""); err != nil {
			return result, err
		}
	case EnrollmentPending:
		if err := st.SetEnrollment(EnrollmentPending, result.DeviceID, "", resp.Message); err != nil {
			return result, err
		}
	case EnrollmentRejected:
		if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", resp.Message); err != nil {
			return result, err
		}
	default:
		return result, fmt.Errorf("unexpected enrollment status: %s", resp.Status)
	}
	return result, nil
}

// PollEnrollment GETs /api/devices/register/status.
func PollEnrollment(b Branding, st *AppState, version string) (EnrollmentStatus, error) {
	deviceID, _, _, _ := st.Snapshot()
	url := fmt.Sprintf("%s/devices/register/status?device_id=%s", apiBaseURL(b), deviceID)
	// #region agent log
	debugLog("H3", "enrollment.go:PollEnrollment", "poll request", map[string]any{"url": url, "device_id": deviceID})
	// #endregion

	var resp enrollmentResponse
	code, err := apiJSON(http.MethodGet, url, nil, &resp)
	if err != nil {
		return EnrollmentStatus{}, err
	}
	// #region agent log
	debugLog("H3", "enrollment.go:PollEnrollment", "poll response", map[string]any{
		"http_code": code, "status": resp.Status, "token_len": len(strings.TrimSpace(resp.DeviceToken)),
		"message": resp.Message,
	})
	// #endregion
	if code == http.StatusNotFound {
		// Lost pending state on server — re-register.
		return RegisterDevice(b, st, version)
	}
	if code != http.StatusOK {
		return EnrollmentStatus{}, fmt.Errorf("status poll failed (HTTP %d)", code)
	}

	result := EnrollmentStatus{
		Status:      resp.Status,
		DeviceID:    resp.DeviceID,
		DeviceToken: strings.TrimSpace(resp.DeviceToken),
		Message:     resp.Message,
	}
	if result.DeviceID == "" {
		result.DeviceID = deviceID
	}

	switch resp.Status {
	case EnrollmentApproved:
		if result.DeviceToken == "" {
			return RegisterDevice(b, st, version)
		}
		if err := st.SetEnrollment(EnrollmentApproved, result.DeviceID, result.DeviceToken, ""); err != nil {
			return result, err
		}
	case EnrollmentPending:
		_ = st.SetEnrollmentMessage(resp.Message)
	case EnrollmentRejected:
		if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", resp.Message); err != nil {
			return result, err
		}
	}
	return result, nil
}

// StartEnrollmentPoll runs until approved/rejected or ctx cancelled.
func StartEnrollmentPoll(b Branding, st *AppState, version string, interval time.Duration, onUpdate func(EnrollmentStatus)) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			res, err := PollEnrollment(b, st, version)
			if err != nil {
				// #region agent log
				debugLog("H3", "enrollment.go:StartEnrollmentPoll", "poll error", map[string]any{"error": err.Error()})
				// #endregion
				continue
			}
			if onUpdate != nil {
				onUpdate(res)
			}
			if res.Status != EnrollmentPending {
				return
			}
		}
	}()
}
