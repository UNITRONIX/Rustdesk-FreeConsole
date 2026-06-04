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
	Status      string `json:"status"`
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token,omitempty"`
	Message     string `json:"message,omitempty"`
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
		return EnrollmentStatus{}, fmt.Errorf("no server address configured")
	}

	st.mu.Lock()
	status := st.EnrollmentStatus
	token := st.DeviceToken
	deviceID := st.DeviceID
	st.mu.Unlock()

	if status == EnrollmentApproved {
		if token != "" {
			return EnrollmentStatus{
				Status:      EnrollmentApproved,
				DeviceID:    deviceID,
				DeviceToken: token,
			}, nil
		}
		// Approved on server but token missing locally (e.g. status poll before fix).
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
		"uuid":        machineSeed(),
		"hostname":    hostname,
		"platform":    fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH),
		"version":     version,
		"device_type": "os_agent",
	}
	if b.BundleID != "" {
		payload["bundle_id"] = b.BundleID
	}
	if tok := strings.TrimSpace(b.EnrollmentToken); tok != "" {
		payload["token"] = tok
	}
	tags := []string{"support-agent"}
	if IsPortable() {
		tags = append(tags, "portable")
	} else {
		tags = append(tags, "installed")
	}
	payload["tags"] = tags

	url := apiBaseURL(b) + "/devices/register"
	var resp enrollmentResponse
	code, err := apiJSON(http.MethodPost, url, payload, &resp)
	if err != nil {
		return EnrollmentStatus{}, err
	}
	if code != http.StatusOK && code != http.StatusAccepted {
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

	var resp enrollmentResponse
	code, err := apiJSON(http.MethodGet, url, nil, &resp)
	if err != nil {
		return EnrollmentStatus{}, err
	}
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
