package main

import (
	"fmt"
	"net/http"
	"net/url"
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
	message := st.EnrollmentMessage
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
			res, err := RegisterDevice(b, st, version)
			if err == nil || res.Status == EnrollmentRejected {
				return res, err
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
			Message:  message,
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
	publicKey, proofErr := enrollmentPublicKey(st)
	if proofErr != nil {
		return EnrollmentStatus{}, fmt.Errorf("create enrollment identity: %w", proofErr)
	}
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
		"public_key":  publicKey,
	}
	if b.BundleID != "" {
		payload["bundle_id"] = b.BundleID
	}
	// A bundle credential is never embedded or sent here. An already-approved
	// device may authenticate its own refresh with its per-device bearer token
	// (set below), which prevents unnecessary token re-issuance.
	tags := []string{"support-agent"}
	if IsPortable() {
		tags = append(tags, "portable")
	} else {
		tags = append(tags, "installed")
	}
	payload["tags"] = strings.Join(tags, ",")

	var resp enrollmentResponse
	var code int
	var err error
	var url string
	for _, base := range CandidateAPIBases(b, st) {
		url = strings.TrimRight(base, "/") + "/devices/register"
		headers, proofErr := enrollmentProofHeaders(http.MethodPost, url, deviceID, st)
		if proofErr != nil {
			return EnrollmentStatus{}, proofErr
		}
		_, currentToken, _ := st.EnrollmentSnapshot()
		if currentToken != "" {
			headers.Set("Authorization", "Bearer "+currentToken)
		}
		// #region agent log
		debugLog("H1", "enrollment.go:RegisterDevice", "register request", map[string]any{
			"url": url, "device_id": deviceID, "sends_token": false,
			"bundle_id": b.BundleID, "use_https": b.UseHTTPS,
		})
		// #endregion
		code, err = apiJSONWithHeaders(http.MethodPost, url, payload, headers, &resp)
		if err == nil {
			st.RememberGoodEndpoints("", base)
			break
		}
	}
	if err != nil {
		return EnrollmentStatus{}, err
	}
	// #region agent log
	debugLog("H2", "enrollment.go:RegisterDevice", "register response", map[string]any{
		"http_code": code, "status": resp.Status, "device_id": resp.DeviceID,
		"token_len": len(strings.TrimSpace(resp.DeviceToken)), "message": resp.Message,
	})
	// #endregion
	result := EnrollmentStatus{
		Status:      resp.Status,
		DeviceID:    resp.DeviceID,
		DeviceToken: strings.TrimSpace(resp.DeviceToken),
		Message:     resp.Message,
	}
	if result.DeviceID == "" {
		result.DeviceID = deviceID
	}

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
		if result.Status == EnrollmentRejected {
			if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", result.Message); err != nil {
				return result, err
			}
			return result, nil
		}
		return result, fmt.Errorf("registration failed (HTTP %d)", code)
	}

	switch resp.Status {
	case EnrollmentApproved:
		if result.DeviceToken == "" {
			// Ordinary authenticated refreshes intentionally do not re-emit
			// the long-lived device credential. Retain the locally encrypted
			// token instead of treating a successful refresh as an error.
			st.mu.Lock()
			result.DeviceToken = strings.TrimSpace(st.DeviceToken)
			st.mu.Unlock()
			if result.DeviceToken == "" {
				return result, fmt.Errorf("registration approved without device_token")
			}
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
	var resp enrollmentResponse
	var code int
	var err error
	var requestURL string
	for _, base := range CandidateAPIBases(b, st) {
		requestURL = strings.TrimRight(base, "/") + "/devices/register/status?device_id=" + url.QueryEscape(deviceID)
		headers, proofErr := enrollmentProofHeaders(http.MethodGet, requestURL, deviceID, st)
		if proofErr != nil {
			return EnrollmentStatus{}, proofErr
		}
		_, currentToken, _ := st.EnrollmentSnapshot()
		if currentToken != "" {
			headers.Set("Authorization", "Bearer "+currentToken)
		}
		// #region agent log
		debugLog("H3", "enrollment.go:PollEnrollment", "poll request", map[string]any{"url": requestURL, "device_id": deviceID})
		// #endregion
		code, err = apiJSONWithHeaders(http.MethodGet, requestURL, nil, headers, &resp)
		if err == nil {
			st.RememberGoodEndpoints("", base)
			break
		}
	}
	if err != nil {
		return EnrollmentStatus{}, err
	}
	// #region agent log
	debugLog("H3", "enrollment.go:PollEnrollment", "poll response", map[string]any{
		"http_code": code, "status": resp.Status, "token_len": len(strings.TrimSpace(resp.DeviceToken)),
		"message": resp.Message,
	})
	// #endregion
	result := EnrollmentStatus{
		Status:      resp.Status,
		DeviceID:    resp.DeviceID,
		DeviceToken: strings.TrimSpace(resp.DeviceToken),
		Message:     resp.Message,
	}
	if result.DeviceID == "" {
		result.DeviceID = deviceID
	}

	if code == http.StatusNotFound {
		st.mu.Lock()
		localStatus := st.EnrollmentStatus
		st.mu.Unlock()
		if localStatus == EnrollmentPending {
			// A pending request may have been pruned before a decision. It has
			// no active credential, so retrying registration is safe.
			return RegisterDevice(b, st, version)
		}
		result := EnrollmentStatus{
			Status:   EnrollmentRejected,
			DeviceID: deviceID,
			Message:  "device enrollment is no longer recognized by the server",
		}
		if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", result.Message); err != nil {
			return result, err
		}
		return result, nil
	}
	if code == http.StatusForbidden && resp.Status == EnrollmentRejected {
		result := EnrollmentStatus{
			Status:   EnrollmentRejected,
			DeviceID: deviceID,
			Message:  resp.Message,
		}
		if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", result.Message); err != nil {
			return result, err
		}
		return result, nil
	}
	if code != http.StatusOK {
		if result.Status == EnrollmentRejected {
			if err := st.SetEnrollment(EnrollmentRejected, result.DeviceID, "", result.Message); err != nil {
				return result, err
			}
			return result, nil
		}
		return result, fmt.Errorf("status poll failed (HTTP %d)", code)
	}

	switch resp.Status {
	case EnrollmentApproved:
		if result.DeviceToken == "" {
			st.mu.Lock()
			result.DeviceToken = strings.TrimSpace(st.DeviceToken)
			st.mu.Unlock()
			if result.DeviceToken == "" {
				return RegisterDevice(b, st, version)
			}
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

// StartEnrollmentRevalidation checks an already-approved device periodically
// so a server-side revoke/disable stops the local transport without requiring
// a restart. Network failures are intentionally retried rather than turning a
// transient outage into an enrollment decision.
func StartEnrollmentRevalidation(b Branding, st *AppState, version string, interval time.Duration, onUpdate func(EnrollmentStatus)) {
	if interval <= 0 {
		interval = time.Minute
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			status, _, _ := st.EnrollmentSnapshot()
			if status != EnrollmentApproved {
				return
			}
			result, err := PollEnrollment(b, st, version)
			if err != nil {
				continue
			}
			if result.Status == EnrollmentApproved {
				continue
			}
			if onUpdate != nil {
				onUpdate(result)
			}
			return
		}
	}()
}
