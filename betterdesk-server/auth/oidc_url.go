package auth

import (
	"context"
	"fmt"
	"net"
	"net/http"
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
	return u, nil
}

func validateOIDCFetchHost(host string) error {
	if strings.EqualFold(host, "localhost") {
		return fmt.Errorf("OIDC URL host not allowed")
	}
	if ip := net.ParseIP(host); ip != nil {
		return validateOIDCFetchIP(ip)
	}
	return nil
}

func validateOIDCFetchIP(ip net.IP) error {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return fmt.Errorf("OIDC URL host not allowed")
	}
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return fmt.Errorf("OIDC URL host not allowed")
	}
	return nil
}

func resolveOIDCFetchHost(ctx context.Context, host string) error {
	if err := validateOIDCFetchHost(host); err != nil {
		return err
	}
	if net.ParseIP(host) != nil {
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("OIDC URL host lookup failed: %w", err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("OIDC URL host lookup returned no addresses")
	}
	for _, addr := range addrs {
		if err := validateOIDCFetchIP(addr.IP); err != nil {
			return err
		}
	}
	return nil
}

// oidcHostResolver validates OIDC hosts before outbound fetch (overridable in tests).
var oidcHostResolver = resolveOIDCFetchHost

func buildOIDCFetchURL(u *url.URL) string {
	safe := &url.URL{
		Scheme:   u.Scheme,
		Host:     u.Host,
		Path:     u.EscapedPath(),
		RawQuery: u.RawQuery,
		Fragment: "",
	}
	return safe.String()
}

// fetchValidatedHTTPGet performs an HTTP GET only after validateOIDCFetchURL succeeds.
func fetchValidatedHTTPGet(client *http.Client, raw string) (*http.Response, error) {
	return fetchValidatedHTTPGetContext(context.Background(), client, raw)
}

// fetchValidatedHTTPGetContext is like fetchValidatedHTTPGet but honors ctx cancellation.
func fetchValidatedHTTPGetContext(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	validated, err := validateOIDCFetchURL(raw)
	if err != nil {
		return nil, err
	}
	if err := oidcHostResolver(ctx, validated.Hostname()); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, buildOIDCFetchURL(validated), nil)
	if err != nil {
		return nil, err
	}
	return client.Do(req)
}
