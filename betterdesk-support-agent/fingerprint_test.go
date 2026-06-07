package main

import (
	"encoding/hex"
	"strings"
	"testing"
)

func TestGenerateDeviceIDUniquePerInstallation(t *testing.T) {
	secA := hex.EncodeToString([]byte("installation-secret-a-0123456789ab"))
	secB := hex.EncodeToString([]byte("installation-secret-b-0123456789ab"))
	idA := generateDeviceID(secA)
	idB := generateDeviceID(secB)
	if idA == idB {
		t.Fatalf("expected different IDs for different installation secrets, got %q", idA)
	}
	if !strings.HasPrefix(idA, "BD-") || !strings.HasPrefix(idB, "BD-") {
		t.Fatalf("expected BD- prefix, got %q and %q", idA, idB)
	}
}

func TestGenerateDeviceIDStable(t *testing.T) {
	sec := hex.EncodeToString([]byte("stable-installation-secret-value"))
	a := generateDeviceID(sec)
	b := generateDeviceID(sec)
	if a != b {
		t.Fatalf("expected stable ID, got %q vs %q", a, b)
	}
}

func TestDeriveDeviceIDWithSuffix(t *testing.T) {
	got := deriveDeviceIDWithSuffix("BD-ABC12", "-2")
	if got != "BD-ABC12-2" {
		t.Fatalf("got %q", got)
	}
}

func TestMachineFingerprintNonEmpty(t *testing.T) {
	fp := machineFingerprint()
	if fp == "" {
		t.Skip("no fingerprint sources on this test host")
	}
	if len(fp) != 32 {
		t.Fatalf("expected 16-byte hex fingerprint, got len %d (%q)", len(fp), fp)
	}
}
