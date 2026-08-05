package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"testing"

	"github.com/unitronix/betterdesk-support-agent/internal/brandprofile"
)

func TestReleaseBrandingRequiresValidSignedProfile(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyResource, err := brandprofile.EncodePublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	profile := []byte(fmt.Sprintf(`{
		"product_name":"Acme Support",
		"bundle_id":"bundle-1",
		"profile_issued_at":"2026-01-01T00:00:00Z",
		"profile_expires_at":"2099-01-01T00:00:00Z",
		"allowed_endpoints":[
			"https://support.example.test",
			"https://support.example.test/api",
			"wss://support.example.test:21122/cdap"
		],
		"server":{
			"address":"https://support.example.test",
			"api_url":"https://support.example.test/api",
			"public_key":"%s",
			"cdap_url":"wss://support.example.test:21122/cdap"
		}
	}`, publicKeyResource))
	signed, err := brandprofile.Sign(profile, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	branding, err := decodeBrandingProfile(signed, []byte(publicKeyResource), true)
	if err != nil {
		t.Fatal(err)
	}
	if branding.ProductName != "Acme Support" || branding.Server == nil ||
		branding.Server.Address != "https://support.example.test" {
		t.Fatalf("unexpected branding: %+v", branding)
	}

	if _, err := decodeBrandingProfile(profile, []byte(publicKeyResource), true); err == nil {
		t.Fatal("release profile unexpectedly accepted unsigned branding")
	}
	missingExpiry, err := brandprofile.Sign([]byte(`{
		"bundle_id":"bundle-1",
		"profile_issued_at":"2026-01-01T00:00:00Z",
		"allowed_endpoints":["https://support.example.test"],
		"server":{"address":"https://support.example.test","api_url":"https://support.example.test/api","cdap_url":"wss://support.example.test:21122/cdap"}
	}`), privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBrandingProfile(missingExpiry, []byte(publicKeyResource), true); err == nil {
		t.Fatal("release profile unexpectedly accepted a profile without expiry")
	}

	tampered := append([]byte(nil), signed...)
	tampered[len(tampered)-1] ^= 1
	if _, err := decodeBrandingProfile(tampered, []byte(publicKeyResource), true); err == nil {
		t.Fatal("release profile unexpectedly accepted tampered branding")
	}
}

func TestDevelopmentBrandingCanUsePlaintextProfile(t *testing.T) {
	branding, err := decodeBrandingProfile(
		[]byte(`{"product_name":"Local Dev","server_address":"http://127.0.0.1:21114"}`),
		nil,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if branding.ProductName != "Local Dev" {
		t.Fatalf("unexpected branding: %+v", branding)
	}
}
