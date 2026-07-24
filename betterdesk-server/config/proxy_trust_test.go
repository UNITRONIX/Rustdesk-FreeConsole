package config

import (
	"net"
	"testing"
)

func TestParseTrustedProxies(t *testing.T) {
	t.Parallel()
	nets, err := ParseTrustedProxies("127.0.0.1/32, 10.0.0.0/8, 2001:db8::1")
	if err != nil {
		t.Fatal(err)
	}
	if len(nets) != 3 {
		t.Fatalf("len=%d, want 3", len(nets))
	}
	if !nets[0].Contains(net.ParseIP("127.0.0.1")) {
		t.Fatal("expected 127.0.0.1 in first net")
	}
	if !nets[2].Contains(net.ParseIP("2001:db8::1")) {
		t.Fatal("expected bare IPv6 to become /128")
	}
}

func TestParseTrustedProxiesInvalid(t *testing.T) {
	t.Parallel()
	if _, err := ParseTrustedProxies("not-an-ip"); err == nil {
		t.Fatal("expected error")
	}
}

func TestShouldHonorForwardedHeaders(t *testing.T) {
	t.Parallel()
	cfg := &Config{
		TrustProxy: true,
		TrustedProxies: []*net.IPNet{
			mustParseCIDR(t, "10.0.0.0/8"),
		},
	}
	if !cfg.ShouldHonorForwardedHeaders("10.0.0.2:50123") {
		t.Fatal("trusted proxy should honor headers")
	}
	if cfg.ShouldHonorForwardedHeaders("203.0.113.1:443") {
		t.Fatal("untrusted remote must not honor headers")
	}
	cfg.TrustedProxies = nil
	if cfg.ShouldHonorForwardedHeaders("10.0.0.2:50123") {
		t.Fatal("empty allowlist must not honor headers")
	}
	cfg.TrustProxy = false
	cfg.TrustedProxies = []*net.IPNet{mustParseCIDR(t, "10.0.0.0/8")}
	if cfg.ShouldHonorForwardedHeaders("10.0.0.2:50123") {
		t.Fatal("TrustProxy=false must not honor headers")
	}
}

func mustParseCIDR(t *testing.T, cidr string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	return n
}
