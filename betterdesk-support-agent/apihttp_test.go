package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInsecureTLSIsDevelopmentOnly(t *testing.T) {
	t.Setenv("BETTERDESK_AGENT_INSECURE_TLS", "1")
	if got, want := tlsInsecureEnabled(), !isReleaseBuild(); got != want {
		t.Fatalf("tlsInsecureEnabled() = %v, want %v (release=%v)", got, want, isReleaseBuild())
	}
}

func TestAPIHTTPClientDoesNotDisableVerificationInRelease(t *testing.T) {
	t.Setenv("BETTERDESK_AGENT_INSECURE_TLS", "1")
	client := apiHTTPClient(time.Second)
	transport, ok := client.Transport.(*http.Transport)

	if isReleaseBuild() {
		if ok && transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
			t.Fatal("release HTTP client disabled TLS verification")
		}
		return
	}
	if !ok || transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("development opt-in did not configure insecure TLS")
	}
}

func TestHTTPGetKeepsVerificationEnabledUnlessDevelopmentOptIn(t *testing.T) {
	t.Setenv("BETTERDESK_AGENT_INSECURE_TLS", "1")
	client := healthHTTPClient("https://desk.example.test/health")
	transport, ok := client.Transport.(*http.Transport)
	if isReleaseBuild() && ok && transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("release health probe would disable TLS verification")
	}
	if !isReleaseBuild() && (!ok || transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify) {
		t.Fatal("development health probe did not configure insecure TLS")
	}
}

func TestAPIHTTPClientWithPinVerifiesServerSPKI(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	sum := sha256.Sum256(server.Certificate().RawSubjectPublicKeyInfo)
	pin := hex.EncodeToString(sum[:])

	response, err := apiHTTPClientWithPin(time.Second, pin).Get(server.URL)
	if err != nil {
		t.Fatalf("pinned request failed: %v", err)
	}
	_ = response.Body.Close()

	if _, err := apiHTTPClientWithPin(time.Second, strings.Repeat("0", 64)).Get(server.URL); err == nil {
		t.Fatal("mismatched server pin unexpectedly succeeded")
	}
}

func TestNormalizeServerCertPin(t *testing.T) {
	pin := "sha256:AA:BB " + strings.Repeat("0", 60)
	if got := normalizeServerCertPin(pin); got != "aabb"+strings.Repeat("0", 60) {
		t.Fatalf("normalized pin = %q", got)
	}
	if got := normalizeServerCertPin("not-a-pin"); got != "" {
		t.Fatalf("invalid pin normalized to %q", got)
	}
}
