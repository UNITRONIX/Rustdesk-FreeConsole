package config

import "time"

// Protocol constants matching RustDesk client expectations.
const (
	// Registration and heartbeat timeouts
	RegTimeout        = 30 * time.Second // Mark peer offline after no heartbeat
	PingTimeout       = 10 * time.Second // Ping timeout
	HeartbeatCheck    = 3 * time.Second  // How often the heartbeat checker runs
	HeartbeatExpected = 15 * time.Second // Expected interval between client heartbeats

	// Device status thresholds (multi-tier)
	// Heartbeats arrive every ~12s. Missed heartbeat count triggers status transitions:
	//   ONLINE   → missed < DegradedThreshold (normal)
	//   DEGRADED → missed >= DegradedThreshold (warning, network issues)
	//   CRITICAL → missed >= CriticalThreshold (severe, about to go offline)
	//   OFFLINE  → missed heartbeats exceed RegTimeout (removed from memory)
	DegradedThreshold = 2 // missed heartbeats before DEGRADED
	CriticalThreshold = 4 // missed heartbeats before CRITICAL

	// Heartbeat interval reported by clients (suggestion in RegisterPeerResponse)
	HeartbeatSuggestion = 12 // seconds

	// TCP connection timeouts
	TCPConnTimeout = 20 * time.Second
	WSConnTimeout  = 20 * time.Second

	// Relay constants
	RelayPairTimeout  = 30 * time.Second // Wait for second connection in relay pairing
	RelayAuthWait     = 2 * time.Second  // Allow signal to authorize a just-arrived relay UUID
	RelayIdleTimeout  = 30 * time.Second // Close relay after inactivity
	CheckRelayTimeout = 3 * time.Second  // Relay health check interval

	// Bandwidth defaults (bytes per second)
	DefaultTotalBandwidth  = 1024 * 1024 * 1024 // 1 GB/s total
	DefaultSingleBandwidth = 16 * 1024 * 1024   // 16 MB/s per session
	DefaultLimitSpeed      = 4 * 1024 * 1024    // 4 MB/s (blacklisted)
	DowngradeThreshold     = 70                 // Downgrade at 70% total bandwidth usage

	// IP rate limiting
	IPRateLimitRegistrations = 20              // Max registrations per IP per window
	IPRateLimitWindow        = 1 * time.Minute // Window for rate limiting
	IPRateLimitCleanup       = 5 * time.Minute // Cleanup stale IP entries

	// Peer status cleanup
	CleanupInterval = 60 * time.Second

	// ID change rate limit
	IDChangeCooldown = 5 * time.Minute

	// Database
	MaxDBConnections = 5

	// Default ports
	DefaultSignalPort = 21116
	DefaultRelayPort  = 21117
	DefaultAPIPort    = 21114

	// Protobuf package name
	ProtobufPackage = "hbb"
)
