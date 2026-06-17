// Package metrics provides Prometheus-compatible metrics exposition.
// Implements the text exposition format without external dependencies.
// Endpoint: GET /metrics
package metrics

import (
	"fmt"
	"io"
	"runtime"
	"sync/atomic"
	"time"
)

// Collector gathers metrics from all server components.
type Collector struct {
	startTime time.Time

	// Counters (monotonically increasing)
	TotalRegistrations atomic.Int64
	TotalExpired       atomic.Int64
	TotalRelaySessions atomic.Int64
	TotalBytesRelayed  atomic.Int64
	ThrottleHits       atomic.Int64
	AuditEvents        atomic.Int64

	// Gauges (current values) - set by periodic collection
	PeersTotal    atomic.Int64
	PeersOnline   atomic.Int64
	PeersDegraded atomic.Int64
	PeersCritical atomic.Int64
	PeersOffline  atomic.Int64
	PeersBanned   atomic.Int64
	PeersUDP      atomic.Int64
	PeersTCP      atomic.Int64
	PeersWS       atomic.Int64

	RelayActiveSessions atomic.Int64
	BlocklistCount      atomic.Int64
	EventSubscribers    atomic.Int64
	BillingPendingRelays atomic.Int64
	Goroutines          atomic.Int64
	MemAllocBytes       atomic.Int64
	MemSysBytes         atomic.Int64
}

// NewCollector creates a new metrics collector.
func NewCollector() *Collector {
	return &Collector{
		startTime: time.Now(),
	}
}

// WritePrometheus writes all metrics in Prometheus text exposition format.
func (c *Collector) WritePrometheus(w io.Writer) {
	// Runtime metrics
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	c.Goroutines.Store(int64(runtime.NumGoroutine()))
	c.MemAllocBytes.Store(int64(mem.Alloc))
	c.MemSysBytes.Store(int64(mem.Sys))

	// Process info
	writeGauge(w, "betterdesk_uptime_seconds", "Server uptime in seconds",
		time.Since(c.startTime).Seconds())

	// Peer gauges
	writeGaugeInt(w, "betterdesk_peers_total", "Total registered peers",
		c.PeersTotal.Load())
	writeGaugeInt(w, "betterdesk_peers_online", "Currently online peers",
		c.PeersOnline.Load())
	writeGaugeInt(w, "betterdesk_peers_degraded", "Peers in degraded state",
		c.PeersDegraded.Load())
	writeGaugeInt(w, "betterdesk_peers_critical", "Peers in critical state",
		c.PeersCritical.Load())
	writeGaugeInt(w, "betterdesk_peers_offline", "Peers in offline state",
		c.PeersOffline.Load())
	writeGaugeInt(w, "betterdesk_peers_banned", "Banned peers",
		c.PeersBanned.Load())

	// Transport breakdown
	writeGaugeInt(w, "betterdesk_peers_udp", "Peers connected via UDP",
		c.PeersUDP.Load())
	writeGaugeInt(w, "betterdesk_peers_tcp", "Peers connected via TCP",
		c.PeersTCP.Load())
	writeGaugeInt(w, "betterdesk_peers_ws", "Peers connected via WebSocket",
		c.PeersWS.Load())

	// Registration counters
	writeCounter(w, "betterdesk_registrations_total", "Total peer registrations",
		c.TotalRegistrations.Load())
	writeCounter(w, "betterdesk_expired_total", "Total expired peers",
		c.TotalExpired.Load())

	// Relay metrics
	writeGaugeInt(w, "betterdesk_relay_active_sessions", "Active relay sessions",
		c.RelayActiveSessions.Load())
	writeCounter(w, "betterdesk_relay_sessions_total", "Total relay sessions",
		c.TotalRelaySessions.Load())
	writeCounter(w, "betterdesk_relay_bytes_total", "Total bytes relayed",
		c.TotalBytesRelayed.Load())
	writeCounter(w, "betterdesk_bandwidth_throttle_hits_total", "Bandwidth throttle events",
		c.ThrottleHits.Load())

	// Security
	writeGaugeInt(w, "betterdesk_blocklist_entries", "Blocklist entry count",
		c.BlocklistCount.Load())

	// Events
	writeGaugeInt(w, "betterdesk_event_subscribers", "Active WebSocket event subscribers",
		c.EventSubscribers.Load())
	writeCounter(w, "betterdesk_audit_events_total", "Total audit events logged",
		c.AuditEvents.Load())

	writeGaugeInt(w, "betterdesk_billing_pending_relays", "Billing relay UUIDs awaiting pairing",
		c.BillingPendingRelays.Load())

	// Go runtime
	writeGaugeInt(w, "betterdesk_goroutines", "Number of goroutines",
		c.Goroutines.Load())
	writeGaugeInt(w, "betterdesk_memory_alloc_bytes", "Memory allocated (bytes)",
		c.MemAllocBytes.Load())
	writeGaugeInt(w, "betterdesk_memory_sys_bytes", "Memory obtained from OS (bytes)",
		c.MemSysBytes.Load())
}

func writeGauge(w io.Writer, name, help string, value float64) {
	fmt.Fprintf(w, "# HELP %s %s\n", name, help)
	fmt.Fprintf(w, "# TYPE %s gauge\n", name)
	fmt.Fprintf(w, "%s %g\n", name, value)
}

func writeGaugeInt(w io.Writer, name, help string, value int64) {
	fmt.Fprintf(w, "# HELP %s %s\n", name, help)
	fmt.Fprintf(w, "# TYPE %s gauge\n", name)
	fmt.Fprintf(w, "%s %d\n", name, value)
}

func writeCounter(w io.Writer, name, help string, value int64) {
	fmt.Fprintf(w, "# HELP %s %s\n", name, help)
	fmt.Fprintf(w, "# TYPE %s counter\n", name)
	fmt.Fprintf(w, "%s %d\n", name, value)
}
