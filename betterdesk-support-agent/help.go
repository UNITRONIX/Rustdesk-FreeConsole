package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// helpRequestPayload mirrors the body the Node.js console route
// (`/api/bd/help-request`) expects. Both new (message/hostname) and legacy
// (description/device_name) keys are sent for forward compatibility.
type helpRequestPayload struct {
	DeviceID    string `json:"device_id"`
	Hostname    string `json:"hostname"`
	Message     string `json:"message"`
	DeviceName  string `json:"device_name"`
	Description string `json:"description"`
	Timestamp   string `json:"timestamp"`
}

// SendHelpRequest posts a help request to the console for the given device.
// The X-Device-Id header is REQUIRED by the console's identifyDevice middleware.
func SendHelpRequest(b Branding, deviceID, message string) error {
	if !b.HasConnection() {
		return fmt.Errorf("no server address configured")
	}
	hostname, _ := os.Hostname()
	payload := helpRequestPayload{
		DeviceID:    deviceID,
		Hostname:    hostname,
		Message:     message,
		DeviceName:  hostname,
		Description: message,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
	}
	return postConsoleJSON(b, "/bd/help-request", deviceID, payload)
}

// CancelHelpRequest withdraws a pending help request.
func CancelHelpRequest(b Branding, deviceID string) error {
	if !b.HasConnection() {
		return fmt.Errorf("no server address configured")
	}
	payload := map[string]string{"device_id": deviceID}
	return postConsoleJSON(b, "/bd/help-request/cancel", deviceID, payload)
}

// postConsoleJSON sends a JSON POST to the console API with the device header.
func postConsoleJSON(b Branding, path, deviceID string, body any) error {
	endpoint := b.ConsoleAPIURL(path)
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Device-Id", deviceID)

	client := &http.Client{Timeout: 12 * time.Second}
	if strings.HasPrefix(endpoint, "https://") || tlsInsecureEnabled() {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: tlsInsecureEnabled()}, //nolint:gosec
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}
	return nil
}
