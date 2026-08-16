package main

import (
	"bytes"
	"testing"
)

func TestStateEncryptionRoundTrip(t *testing.T) {
	plain := []byte(`{"device_id":"BD-TEST","access_password":"secret12"}`)
	blob, err := encryptState(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !isEncryptedState(blob) {
		t.Fatal("expected encrypted magic prefix")
	}
	out, err := decryptState(blob)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(out, plain) {
		t.Fatalf("round-trip mismatch: %q vs %q", out, plain)
	}
}

func TestStateEncryptionTamperFails(t *testing.T) {
	plain := []byte(`{"device_id":"BD-TEST"}`)
	blob, err := encryptState(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	// Flip a ciphertext byte — GCM auth must fail (anti-clone / tamper).
	blob[len(blob)-1] ^= 0xff
	if _, err := decryptState(blob); err == nil {
		t.Fatal("expected decrypt failure after tamper")
	}
}

func TestCandidateEndpointsPreferLastGood(t *testing.T) {
	b := Branding{
		ServerAddress: "https://primary.example.com",
		UseHTTPS:      true,
		Server: &ServerBranding{
			Address: "https://primary.example.com",
			APIURL:  "https://primary.example.com/api",
			CDAPURL: "wss://primary.example.com:21122/cdap",
		},
	}
	st := &AppState{
		LastGoodCDAP: "wss://fallback.example.com:21122/cdap",
		LastGoodAPI:  "https://fallback.example.com/api",
	}
	cdap := CandidateCDAPWebSockets(b, st)
	if len(cdap) < 2 {
		t.Fatalf("expected multiple CDAP candidates, got %v", cdap)
	}
	if cdap[0] != st.LastGoodCDAP {
		t.Fatalf("last-good CDAP should be first, got %q", cdap[0])
	}
	api := CandidateAPIBases(b, st)
	if api[0] != st.LastGoodAPI {
		t.Fatalf("last-good API should be first, got %q", api[0])
	}
}

func TestHealthURLFromCDAPWS(t *testing.T) {
	got := healthURLFromCDAPWS("wss://host.example:21122/cdap")
	want := "https://host.example:21122/cdap/health"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
