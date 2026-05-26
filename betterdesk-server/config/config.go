// Package config provides configuration management for BetterDesk server.
// Supports CLI flags, environment variables, and sensible defaults.
package config

import (
	"log"
	"net"
	"os"
	"strconv"
	"strings"
)

// Enrollment mode constants for Dual Key System.
const (
	EnrollmentModeOpen    = "open"    // Accept all device registrations (backward compatible)
	EnrollmentModeManaged = "managed" // New devices need approval or valid token
	EnrollmentModeLocked  = "locked"  // Only devices with valid tokens can register
)

// Config holds all server configuration.
type Config struct {
	// Network
	SignalPort int // UDP+TCP signal port (default 21116)
	RelayPort  int // TCP relay port (default 21117)
	APIPort    int // HTTP API port (default 21114)

	// Mode
	Mode string // "all", "signal", "relay"

	// Database
	DBPath string // Database DSN: file path for SQLite, postgres:// URI for PostgreSQL

	// Crypto
	KeyFile string // Ed25519 key file path (without extension)

	// Servers
	RelayServers      string // Comma-separated relay server addresses
	RendezvousServers string // Comma-separated rendezvous server addresses

	// Network mask
	Mask string // LAN mask (e.g. "192.168.0.0/24")

	// Relay options
	AlwaysUseRelay bool // Force relay for all connections

	// Security
	BlocklistFile string // Path to blocklist file (IP/ID/CIDR)

	// Audit
	AuditLogFile string // Path to audit log file (JSON lines)

	// TLS
	TLSCertFile string // Path to TLS certificate file
	TLSKeyFile  string // Path to TLS key file

	// Logging
	LogFormat string // "text" or "json"

	// Admin
	AdminPort int // TCP admin interface port (0 = disabled)

	// Security — Authentication
	JWTSecret       string // Secret key for JWT signing (auto-generated if empty)
	JWTExpiry       int    // JWT token expiry in hours (default 24)
	AdminPassword   string // Password for admin TCP interface (empty = no auth)
	ForceHTTPS      bool   // Reject non-TLS API requests (except behind reverse proxy)
	TrustProxy      bool   // Trust X-Forwarded-For / X-Real-IP headers from reverse proxy
	RelayMaxConnsIP int    // Max relay connections per IP (0 = unlimited)
	InitAdminUser   string // Initial admin username (created on first start)
	InitAdminPass   string // Initial admin password (auto-generated if empty)

	// Signal rate limiting (registrations per IP per minute).
	// Issue #122: large NAT deployments may need to raise or disable this
	// (set to 0 to disable rate limiting entirely).
	SignalRateLimitPerIP int

	// SameNATRelay forces relay fallback when both peers connect from the
	// same public IP (i.e. they sit behind the same NAT gateway).  Many
	// consumer routers refuse hairpin NAT, so the LAN-address exchange that
	// normally works in this case can silently fail and the connection
	// times out (issue #121).  Default: enabled.
	SameNATRelay bool

	// WebSocket security (M3)
	AllowedWSOrigins    string // Comma-separated allowed WebSocket origins (empty = allow all)
	APIAllowedWSOrigins string // Comma-separated allowed WebSocket origins for HTTP API events endpoint

	// Metrics endpoint access control (audit fix H-03, 2026-04-10)
	// MetricsAllowlist: comma-separated list of IP / CIDR allowed to call /metrics.
	//   Empty + MetricsPublic=false => /metrics requires authentication.
	//   Non-empty                  => /metrics is open to listed IPs only, no auth.
	// MetricsPublic: when true, /metrics is reachable without auth from anywhere
	//   (legacy behavior). Off by default.
	MetricsAllowlist string
	MetricsPublic    bool

	// TLS for signal/relay/api (Phase 3 + Phase 21)
	TLSSignal bool // Enable TLS on TCP signal (:21116) and WS signal (:21118)
	TLSRelay  bool // Enable TLS on TCP relay (:21117) and WS relay (:21119)
	TLSApi    bool // Enable TLS on HTTP API (:21114) — opt-in, not automatic

	// Dual Key System - Enrollment Mode
	// "open" (default) - Accept all device registrations (backward compatible)
	// "managed" - New devices need to be approved or have a valid token
	// "locked" - Only devices with valid tokens can register
	EnrollmentMode string

	// CDAP Gateway
	CDAPPort      int  // WebSocket gateway port (default 21122)
	CDAPEnabled   bool // Enable CDAP gateway (default false)
	CDAPTLS       bool // Enable TLS on CDAP port
	CDAPRateLimit int  // Max requests per minute per IP (default 30)
}

// DefaultConfig returns a Config with sensible defaults.
func DefaultConfig() *Config {
	return &Config{
		SignalPort:           21116,
		RelayPort:            21117,
		APIPort:              21114,
		Mode:                 "all",
		DBPath:               "./db_v2.sqlite3",
		KeyFile:              "id_ed25519",
		JWTExpiry:            24,
		RelayMaxConnsIP:      20,
		EnrollmentMode:       EnrollmentModeOpen, // Backward compatible default
		CDAPPort:             21122,
		CDAPEnabled:          true, // Enabled by default; set CDAP_ENABLED=N for minimal installs
		CDAPRateLimit:        30,
		SignalRateLimitPerIP: IPRateLimitRegistrations,
		SameNATRelay:         true, // issue #121: auto-fallback to relay on shared public IP
	}
}

// LoadEnv overrides config values from environment variables.
// Environment variables take precedence over CLI flags.
func (c *Config) LoadEnv() {
	// SIGNAL_PORT takes precedence over PORT.
	// This avoids conflicts in Docker single-container setups where PORT=5000
	// is intended for the Node.js console, not the Go signal server.
	if v := os.Getenv("SIGNAL_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.SignalPort = n
		}
	} else if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.SignalPort = n
		}
	}
	if v := os.Getenv("RELAY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.RelayPort = n
		}
	}
	if v := os.Getenv("API_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.APIPort = n
		}
	}
	if v := os.Getenv("MODE"); v != "" {
		c.Mode = strings.ToLower(v)
	}
	if v := os.Getenv("DB_URL"); v != "" {
		c.DBPath = v
	}
	if v := os.Getenv("KEY_FILE"); v != "" {
		c.KeyFile = v
	}
	if v := os.Getenv("RELAY_SERVERS"); v != "" {
		c.RelayServers = v
	}
	if v := os.Getenv("RENDEZVOUS_SERVERS"); v != "" {
		c.RendezvousServers = v
	}
	if v := os.Getenv("MASK"); v != "" {
		c.Mask = v
	}
	if strings.ToUpper(os.Getenv("ALWAYS_USE_RELAY")) == "Y" {
		c.AlwaysUseRelay = true
	}
	if v := os.Getenv("BLOCKLIST_FILE"); v != "" {
		c.BlocklistFile = v
	}
	if v := os.Getenv("AUDIT_LOG_FILE"); v != "" {
		c.AuditLogFile = v
	}
	if v := os.Getenv("TLS_CERT"); v != "" {
		c.TLSCertFile = v
	}
	if v := os.Getenv("TLS_KEY"); v != "" {
		c.TLSKeyFile = v
	}
	if v := os.Getenv("LOG_FORMAT"); v != "" {
		// GO-H6: validate against whitelist to prevent silent misconfiguration
		lv := strings.ToLower(v)
		if lv == "text" || lv == "json" {
			c.LogFormat = lv
		}
	}
	if v := os.Getenv("ADMIN_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.AdminPort = n
		}
	}
	if v := os.Getenv("JWT_SECRET"); v != "" {
		c.JWTSecret = v
	}
	if v := os.Getenv("JWT_EXPIRY_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.JWTExpiry = n
		}
	}
	if v := os.Getenv("ADMIN_PASSWORD"); v != "" {
		c.AdminPassword = v
	}
	if strings.ToUpper(os.Getenv("FORCE_HTTPS")) == "Y" {
		c.ForceHTTPS = true
	}
	if strings.ToUpper(os.Getenv("TRUST_PROXY")) == "Y" {
		c.TrustProxy = true
	}
	if v := os.Getenv("RELAY_MAX_CONNS_PER_IP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.RelayMaxConnsIP = n
		}
	}
	// Issue #122: allow tuning the per-IP signal/registration rate limit
	// without recompiling. Useful for large NAT deployments where many
	// devices share the same public IP. Set to 0 to disable entirely.
	if v := os.Getenv("SIGNAL_RATE_LIMIT_PER_IP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			c.SignalRateLimitPerIP = n
		}
	}
	// Issue #121: when both peers share the same public IP, the LAN
	// hole-punch path requires NAT hairpinning, which many consumer
	// routers (and most cellular gateways) silently drop.  Enabled by
	// default; set SAME_NAT_RELAY=N to fall back to the legacy LAN-exchange
	// behavior.
	if v := os.Getenv("SAME_NAT_RELAY"); v != "" {
		switch strings.ToUpper(v) {
		case "Y", "YES", "1", "TRUE", "ON":
			c.SameNATRelay = true
		case "N", "NO", "0", "FALSE", "OFF":
			c.SameNATRelay = false
		}
	}
	if v := os.Getenv("INIT_ADMIN_USER"); v != "" {
		c.InitAdminUser = v
	}
	if v := os.Getenv("INIT_ADMIN_PASS"); v != "" {
		c.InitAdminPass = v
	}
	if v := os.Getenv("WS_ALLOWED_ORIGINS"); v != "" {
		c.AllowedWSOrigins = v
	}
	if v := os.Getenv("API_WS_ALLOWED_ORIGINS"); v != "" {
		c.APIAllowedWSOrigins = v
	}
	if v := os.Getenv("METRICS_IP_ALLOWLIST"); v != "" {
		c.MetricsAllowlist = v
	}
	if strings.ToUpper(os.Getenv("METRICS_PUBLIC")) == "Y" || strings.ToUpper(os.Getenv("METRICS_PUBLIC")) == "YES" || os.Getenv("METRICS_PUBLIC") == "1" || strings.ToUpper(os.Getenv("METRICS_PUBLIC")) == "TRUE" {
		c.MetricsPublic = true
	}
	if strings.ToUpper(os.Getenv("TLS_SIGNAL")) == "Y" {
		c.TLSSignal = true
	}
	if strings.ToUpper(os.Getenv("TLS_RELAY")) == "Y" {
		c.TLSRelay = true
	}
	if strings.ToUpper(os.Getenv("TLS_API")) == "Y" {
		c.TLSApi = true
	}
	if v := os.Getenv("ENROLLMENT_MODE"); v != "" {
		mode := strings.ToLower(v)
		if mode == "open" || mode == "managed" || mode == "locked" {
			c.EnrollmentMode = mode
		}
	}
	if v := os.Getenv("CDAP_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.CDAPPort = n
		}
	}
	if v := strings.ToUpper(os.Getenv("CDAP_ENABLED")); v == "N" || v == "NO" || v == "FALSE" || v == "0" {
		c.CDAPEnabled = false
	} else if v == "Y" || v == "YES" || v == "TRUE" || v == "1" {
		c.CDAPEnabled = true
	}
	if strings.ToUpper(os.Getenv("CDAP_TLS")) == "Y" {
		c.CDAPTLS = true
	}
	if v := os.Getenv("CDAP_RATE_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.CDAPRateLimit = n
		}
	}
}

// NATTestPort returns the NAT test port (signal port - 1).
func (c *Config) NATTestPort() int {
	return c.SignalPort - 1
}

// WSSignalPort returns the WebSocket signal port (signal port + 2).
func (c *Config) WSSignalPort() int {
	return c.SignalPort + 2
}

// WSRelayPort returns the WebSocket relay port (relay port + 2).
func (c *Config) WSRelayPort() int {
	return c.RelayPort + 2
}

// GetRelayServers parses the comma-separated relay server list.
// Ensures each entry includes a port; appends the default RelayPort if missing.
// Validates that each entry resolves to a valid IP or hostname (rejects single
// characters and obviously bogus values that would cause relay failures).
func (c *Config) GetRelayServers() []string {
	if c.RelayServers == "" {
		return nil
	}
	servers := strings.Split(c.RelayServers, ",")
	result := make([]string, 0, len(servers))
	for _, s := range servers {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		// Add default relay port if not specified.
		// net.SplitHostPort handles IPv6 bracketed addresses correctly.
		if _, _, err := net.SplitHostPort(s); err != nil {
			s = net.JoinHostPort(s, strconv.Itoa(c.RelayPort))
		}
		// Validate: extract the host part and reject obviously invalid entries
		// (single letter, empty host, etc.) that would produce relay addresses
		// like "a:21117" which cause all relay connections to fail.
		host, _, err := net.SplitHostPort(s)
		if err != nil || len(host) < 2 {
			log.Printf("[config] WARNING: Ignoring invalid relay server %q (host too short or malformed)", s)
			continue
		}
		result = append(result, s)
	}
	return result
}

// GetAllowedWSOrigins parses the comma-separated list of allowed WebSocket origins.
// Returns nil if empty (meaning all origins are allowed for backward compatibility).
// Supports glob patterns accepted by nhooyr.io/websocket:
//   - "*" matches any origin
//   - "*.example.com" matches subdomains
//   - "https://app.example.com" matches exact origin
func (c *Config) GetAllowedWSOrigins() []string {
	if c.AllowedWSOrigins == "" {
		return nil
	}
	origins := strings.Split(c.AllowedWSOrigins, ",")
	result := make([]string, 0, len(origins))
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

// GetAPIAllowedWSOrigins parses the comma-separated list of allowed WebSocket origins
// for the HTTP API events endpoint. Returns nil if empty (defaults to safe same-origin
// behavior enforced by the WebSocket library).
func (c *Config) GetAPIAllowedWSOrigins() []string {
	if c.APIAllowedWSOrigins == "" {
		return nil
	}
	origins := strings.Split(c.APIAllowedWSOrigins, ",")
	result := make([]string, 0, len(origins))
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

// GetMetricsAllowlist returns the parsed list of IP / CIDR allowed to call /metrics.
// Used together with MetricsPublic to decide whether to require authentication.
func (c *Config) GetMetricsAllowlist() []string {
	if c.MetricsAllowlist == "" {
		return nil
	}
	parts := strings.Split(c.MetricsAllowlist, ",")
	result := make([]string, 0, len(parts))
	for _, o := range parts {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

// HasTLSCert returns true if both TLS certificate and key files are configured.
func (c *Config) HasTLSCert() bool {
	return c.TLSCertFile != "" && c.TLSKeyFile != ""
}

// SignalTLSEnabled returns true if TLS should be used for signal server
// TCP and WebSocket listeners. Requires both --tls-signal flag and valid cert/key.
func (c *Config) SignalTLSEnabled() bool {
	return c.TLSSignal && c.HasTLSCert()
}

// RelayTLSEnabled returns true if TLS should be used for relay server
// TCP and WebSocket listeners. Requires both --tls-relay flag and valid cert/key.
func (c *Config) RelayTLSEnabled() bool {
	return c.TLSRelay && c.HasTLSCert()
}

// APITLSEnabled returns true if TLS should be used for the HTTP API server.
// Requires explicit --tls-api flag and valid cert/key.
// NOTE: --force-https does NOT imply API TLS because RustDesk desktop clients
// always send plain HTTP to signal_port-2 (the API port). Enabling TLS on the
// API would return HTTP 400 to every client and prevent device registration.
func (c *Config) APITLSEnabled() bool {
	return c.TLSApi && c.HasTLSCert()
}

// CDAPTLSEnabled returns true if TLS should be used for the CDAP WebSocket gateway.
func (c *Config) CDAPTLSEnabled() bool {
	return c.CDAPTLS && c.HasTLSCert()
}
