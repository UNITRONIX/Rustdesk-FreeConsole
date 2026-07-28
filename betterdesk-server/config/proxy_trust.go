package config

import (
	"fmt"
	"log"
	"net"
	"strings"
)

// ParseTrustedProxies parses a comma-separated list of CIDRs or single IPs
// into IPNet entries. Bare IPs become /32 (IPv4) or /128 (IPv6).
func ParseTrustedProxies(raw string) ([]*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	nets := make([]*net.IPNet, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.Contains(p, "/") {
			ip := net.ParseIP(p)
			if ip == nil {
				return nil, fmt.Errorf("invalid trusted proxy IP %q", p)
			}
			if ip4 := ip.To4(); ip4 != nil {
				p = ip4.String() + "/32"
			} else {
				p = ip.String() + "/128"
			}
		}
		_, n, err := net.ParseCIDR(p)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q: %w", p, err)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

// RemoteAddrIsTrustedProxy reports whether the direct TCP peer (r.RemoteAddr)
// is in TrustedProxies. Returns false when the allowlist is empty so
// TRUST_PROXY=Y alone cannot honor spoofable X-Forwarded-* headers (#276).
func (c *Config) RemoteAddrIsTrustedProxy(remoteAddr string) bool {
	if c == nil || len(c.TrustedProxies) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, n := range c.TrustedProxies {
		if n != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// IPIsPanelSignalProxy reports whether ip is in PanelSignalProxyCIDRs
// (Node panel → hbbs TCP proxy for Web Remote). Empty allowlist → false.
func (c *Config) IPIsPanelSignalProxy(ip net.IP) bool {
	if c == nil || ip == nil || len(c.PanelSignalProxyCIDRs) == 0 {
		return false
	}
	for _, n := range c.PanelSignalProxyCIDRs {
		if n != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// ShouldHonorForwardedHeaders is true only when TrustProxy is set and the
// direct connection comes from a configured trusted proxy CIDR.
func (c *Config) ShouldHonorForwardedHeaders(remoteAddr string) bool {
	return c != nil && c.TrustProxy && c.RemoteAddrIsTrustedProxy(remoteAddr)
}

// WarnProxyTrustMisconfig logs when TRUST_PROXY is enabled without an allowlist.
func (c *Config) WarnProxyTrustMisconfig() {
	if c == nil || !c.TrustProxy {
		return
	}
	if len(c.TrustedProxies) == 0 {
		log.Printf("[config] TRUST_PROXY=Y but TRUSTED_PROXIES is empty — X-Forwarded-For/X-Real-IP headers will be IGNORED. Set TRUSTED_PROXIES to your reverse proxy CIDR(s), e.g. 127.0.0.1/32,10.0.0.0/8 (#276)")
	}
}
