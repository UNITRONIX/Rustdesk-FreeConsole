package main

import (
	"net/http"
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
