package api

import (
	"encoding/json"
	"testing"
)

// Documents the Phase 4 identity contract: managed enrollment responses must
// not carry a device_token until the operator approves the device.
func TestManagedEnrollmentResponseOmitsDeviceToken(t *testing.T) {
	resp := EnrollmentResponse{
		Status:   "pending",
		DeviceID: "BD-TESTDEVICE0001",
		Message:  "Waiting for operator approval",
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["device_token"]; ok {
		t.Fatalf("pending managed enrollment must omit device_token, got %v", decoded["device_token"])
	}
	if decoded["status"] != "pending" {
		t.Fatalf("status=%v", decoded["status"])
	}
}

func TestApprovedEnrollmentResponseIncludesDeviceTokenField(t *testing.T) {
	resp := EnrollmentResponse{
		Status:      "approved",
		DeviceID:    "BD-TESTDEVICE0001",
		DeviceToken: "unique-per-device-token",
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["device_token"] != "unique-per-device-token" {
		t.Fatalf("approved enrollment must include device_token, got %v", decoded["device_token"])
	}
}
