package main

import (
	"errors"
	"testing"
)

func TestBuildConfigDoesNotRegisterWhenAccessIsDisabled(t *testing.T) {
	st := &AppState{
		DeviceID:         "BD-TEST",
		DeviceToken:      "device-token",
		EnrollmentStatus: EnrollmentApproved,
		AccessMode:       AccessDisabled,
		AccessPassword:   "secret12",
	}

	cfg, err := buildConfig(Branding{ServerAddress: "https://127.0.0.1:1"}, st, "test", nil)
	if !errors.Is(err, errRemoteAccessDisabled) {
		t.Fatalf("buildConfig error = %v, want disabled access error", err)
	}
	if cfg != nil {
		t.Fatalf("buildConfig config = %#v, want nil when access is disabled", cfg)
	}
}
