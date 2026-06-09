package auth

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// validateOIDCFetchURL checks an admin-configured OIDC HTTP(S) URL before the
// server fetches it (discovery / test). Blocks non-HTTP(S) schemes, embedded
// credentials, and cloud-metadata / link-local literal IPs.
func validateOIDCFetchURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, fmt.Errorf("OIDC URL must use http or https")
	}
	if u.User != nil {
		return nil, fmt.Errorf("OIDC URL must not contain credentials")
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("OIDC URL missing host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return nil, fmt.Errorf("OIDC URL host not allowed")
		}
		if ip.Equal(net.ParseIP("169.254.169.254")) {
			return nil, fmt.Errorf("OIDC URL host not allowed")
		}
	}
	return u, nil
}
