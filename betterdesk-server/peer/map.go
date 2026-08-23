// Package peer provides a concurrent in-memory peer map for the BetterDesk signal server.
// It tracks connected peers, their addresses, heartbeats, and NAT types.
// The status tracking system uses a 4-tier model:
//
//	ONLINE   → heartbeat within expected interval
//	DEGRADED → 2-3 missed heartbeats (warning)
//	CRITICAL → 4+ missed heartbeats (about to go offline)
//	OFFLINE  → exceeded RegTimeout (removed from memory map, persisted in DB)
package peer

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ConnType identifies how a peer is connected to the signal server.
type ConnType int

const (
	ConnUDP ConnType = iota
	ConnTCP
	ConnWS
)

// String returns a human-readable connection type.
func (c ConnType) String() string {
	switch c {
	case ConnUDP:
		return "udp"
	case ConnTCP:
		return "tcp"
	case ConnWS:
		return "ws"
	default:
		return "unknown"
	}
}

// Status represents the current status tier of a peer.
type Status string

const (
	StatusOnline   Status = "ONLINE"
	StatusDegraded Status = "DEGRADED"
	StatusCritical Status = "CRITICAL"
	StatusOffline  Status = "OFFLINE"
)

// Entry represents a single connected peer in the signal server's memory.
type Entry struct {
	ID        string       // RustDesk device ID (e.g., "ABC123456")
	UUID      []byte       // Device installation UUID
	PK        []byte       // Ed25519 public key (32 bytes)
	IP        string       // Last known IP:port
	NATType   int32        // 0=unknown, 1=asymmetric, 2=symmetric
	Serial    int32        // Registration serial number
	ConnType  ConnType     // UDP, TCP, or WS
	UDPAddr   *net.UDPAddr // For UDP peers — used to send messages back
	TCPConn   net.Conn     // For TCP peers — persistent connection
	WSConn    interface{}  // For WS peers — typed during WebSocket implementation
	LastReg   time.Time    // Last RegisterPeer timestamp (heartbeat)
	Disabled  bool         // Peer is disabled (won't appear online)
	Banned    bool         // Peer is banned (reject connections)
	LocalAddr string       // Peer's self-reported local address
	Version   string       // Client version string

	// Enhanced status tracking
	FirstSeen       time.Time // When the peer was first registered in this session
	HeartbeatCount  int64     // Total heartbeats received in this session
	MissedBeats     int32     // Consecutive missed heartbeat checks
	LastStatusCheck time.Time // When the last status check was performed
	StatusTier      Status    // Current computed status tier
	IPHistory       []string  // Recent IP addresses (max 5, for roaming detection)
	LastDBSync      time.Time // Last time status was synced to database
}

// IsExpired returns true if the peer hasn't sent a heartbeat within timeout.
func (e *Entry) IsExpired(timeout time.Duration) bool {
	return time.Since(e.LastReg) > timeout
}

// CloseConnections closes any open TCP or WebSocket connections held by this entry.
// Safe to call multiple times; ignores nil connections and close errors.
func (e *Entry) CloseConnections() {
	if e.TCPConn != nil {
		e.TCPConn.Close()
		e.TCPConn = nil
	}
	if e.WSConn != nil {
		// WSConn is interface{} — attempt to close if it implements io.Closer.
		if closer, ok := e.WSConn.(interface{ Close() error }); ok {
			closer.Close()
		}
		e.WSConn = nil
	}
}

// ComputeStatus computes the current status tier based on missed heartbeats.
func (e *Entry) ComputeStatus(degradedThreshold, criticalThreshold int32) Status {
	if e.MissedBeats >= criticalThreshold {
		return StatusCritical
	}
	if e.MissedBeats >= degradedThreshold {
		return StatusDegraded
	}
	return StatusOnline
}

// Uptime returns the duration since the peer first registered in this session.
func (e *Entry) Uptime() time.Duration {
	if e.FirstSeen.IsZero() {
		return 0
	}
	return time.Since(e.FirstSeen)
}

// TimeSinceLastHeartbeat returns time elapsed since last heartbeat.
func (e *Entry) TimeSinceLastHeartbeat() time.Duration {
	return time.Since(e.LastReg)
}

// Snapshot is a read-only copy of peer state for API responses.
// Thread-safe — created under lock, can be passed to other goroutines.
type Snapshot struct {
	ID                    string    `json:"id"`
	IP                    string    `json:"ip"`
	NATType               int32     `json:"nat_type"`
	ConnType              string    `json:"conn_type"`
	Status                Status    `json:"status"`
	Version               string    `json:"version,omitempty"`
	LocalAddr             string    `json:"local_addr,omitempty"`
	Banned                bool      `json:"banned"`
	Disabled              bool      `json:"disabled"`
	FirstSeen             time.Time `json:"first_seen"`
	LastHeartbeat         time.Time `json:"last_heartbeat"`
	HeartbeatCount        int64     `json:"heartbeat_count"`
	MissedBeats           int32     `json:"missed_beats"`
	Uptime                string    `json:"uptime"`
	TimeSinceLastBeat     string    `json:"time_since_last_beat"`
	IPHistory             []string  `json:"ip_history,omitempty"`
	UptimeSeconds         float64   `json:"uptime_seconds"`
	TimeSinceLastBeatSecs float64   `json:"time_since_last_beat_secs"`
	HasPK                 bool      `json:"has_pk"`
}

// Snapshot creates a thread-safe read-only copy of this entry.
func (e *Entry) Snapshot(degradedThreshold, criticalThreshold int32) Snapshot {
	status := e.ComputeStatus(degradedThreshold, criticalThreshold)
	uptime := e.Uptime()
	sinceBeat := e.TimeSinceLastHeartbeat()

	s := Snapshot{
		ID:                    e.ID,
		IP:                    e.IP,
		NATType:               e.NATType,
		ConnType:              e.ConnType.String(),
		Status:                status,
		Version:               e.Version,
		LocalAddr:             e.LocalAddr,
		Banned:                e.Banned,
		Disabled:              e.Disabled,
		FirstSeen:             e.FirstSeen,
		LastHeartbeat:         e.LastReg,
		HeartbeatCount:        e.HeartbeatCount,
		MissedBeats:           e.MissedBeats,
		Uptime:                uptime.String(),
		TimeSinceLastBeat:     sinceBeat.String(),
		UptimeSeconds:         uptime.Seconds(),
		TimeSinceLastBeatSecs: sinceBeat.Seconds(),
		HasPK:                 len(e.PK) > 0,
	}

	// Copy IP history
	if len(e.IPHistory) > 0 {
		s.IPHistory = make([]string, len(e.IPHistory))
		copy(s.IPHistory, e.IPHistory)
	}

	return s
}

// Stats holds aggregate status statistics for the peer map.
type Stats struct {
	Total         int     `json:"total"`
	Online        int     `json:"online"`
	Degraded      int     `json:"degraded"`
	Critical      int     `json:"critical"`
	UDP           int     `json:"udp"`
	TCP           int     `json:"tcp"`
	WS            int     `json:"ws"`
	Banned        int     `json:"banned"`
	Disabled      int     `json:"disabled"`
	AvgUptimeSecs float64 `json:"avg_uptime_secs"`
	AvgBeatAge    float64 `json:"avg_beat_age_secs"`
}

// Map is a concurrent in-memory map of all peers currently registered.
// It is the core data structure of the signal server — all lookups are O(1).
type Map struct {
	mu      sync.RWMutex
	entries map[string]*Entry // Key: peer ID

	// Counters (atomic for lock-free reads from metrics)
	totalRegistrations atomic.Int64
	totalExpired       atomic.Int64
}

// NewMap creates a new empty peer map.
func NewMap() *Map {
	return &Map{
		entries: make(map[string]*Entry),
	}
}

// Get returns a peer entry by ID, or nil if not found.
func (m *Map) Get(id string) *Entry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.entries[id]
}

// Put adds or updates a peer entry. Returns the previous entry (nil if new).
func (m *Map) Put(e *Entry) *Entry {
	m.mu.Lock()
	defer m.mu.Unlock()
	old := m.entries[e.ID]
	m.entries[e.ID] = e
	if old == nil {
		m.totalRegistrations.Add(1)
	}
	return old
}

// UpdateHeartbeat refreshes the heartbeat timestamp and address for a peer.
// Returns false if the peer is not in the map.
func (m *Map) UpdateHeartbeat(id string, addr *net.UDPAddr, serial int32) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entries[id]
	if !ok {
		return false
	}
	e.LastReg = time.Now()
	e.Serial = serial
	e.MissedBeats = 0
	e.HeartbeatCount++
	if addr != nil {
		newIP := addr.String()
		// Track IP changes for roaming detection
		if e.IP != "" && e.IP != newIP {
			e.IPHistory = append(e.IPHistory, e.IP)
			if len(e.IPHistory) > 5 {
				e.IPHistory = e.IPHistory[len(e.IPHistory)-5:]
			}
		}
		e.UDPAddr = addr
		e.IP = newIP
		// TCP RegisterPk can stamp ConnTCP before the OS service heartbeats
		// (#327 / #382). A live UDP address means inbound PunchHole/RequestRelay
		// must go over UDP — do not leave ConnType stuck on tcp.
		if e.ConnType != ConnWS {
			e.ConnType = ConnUDP
		}
	}
	return true
}

// TouchHeartbeat refreshes the heartbeat timestamp without changing address or serial.
// It is used by transports where protocol-level keepalive frames prove the peer is alive.
func (m *Map) TouchHeartbeat(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entries[id]
	if !ok {
		return false
	}
	e.LastReg = time.Now()
	e.MissedBeats = 0
	e.StatusTier = StatusOnline
	e.HeartbeatCount++
	return true
}

// Remove deletes a peer from the map. Returns the removed entry (nil if not found).
// Closes any open TCP/WS connections to force immediate disconnect.
func (m *Map) Remove(id string) *Entry {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entries[id]
	if !ok {
		return nil
	}
	e.CloseConnections()
	delete(m.entries, id)
	return e
}

// Count returns the number of peers currently in the map.
func (m *Map) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}

// IDs returns a snapshot of all peer IDs currently in the map.
func (m *Map) IDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.entries))
	for id := range m.entries {
		ids = append(ids, id)
	}
	return ids
}

// CheckHeartbeats increments missed beat counters for peers due for a status check.
// Phase 1 collects due peer IDs under a read lock; phase 2 updates each entry
// under a short write lock so registration traffic is not blocked for the full scan.
func (m *Map) CheckHeartbeats(interval time.Duration, degradedThreshold, criticalThreshold int32) (degraded, critical []string) {
	now := time.Now()

	m.mu.RLock()
	due := make([]string, 0, len(m.entries))
	for id, e := range m.entries {
		if now.Sub(e.LastStatusCheck) >= interval {
			due = append(due, id)
		}
	}
	m.mu.RUnlock()

	for _, id := range due {
		m.mu.Lock()
		e, ok := m.entries[id]
		if !ok {
			m.mu.Unlock()
			continue
		}
		if now.Sub(e.LastStatusCheck) < interval {
			m.mu.Unlock()
			continue
		}
		e.LastStatusCheck = now

		if now.Sub(e.LastReg) > interval {
			oldStatus := e.ComputeStatus(degradedThreshold, criticalThreshold)
			e.MissedBeats++
			newStatus := e.ComputeStatus(degradedThreshold, criticalThreshold)

			if newStatus != oldStatus {
				switch newStatus {
				case StatusDegraded:
					degraded = append(degraded, e.ID)
				case StatusCritical:
					critical = append(critical, e.ID)
				}
			}
			e.StatusTier = newStatus
		} else {
			e.MissedBeats = 0
			e.StatusTier = StatusOnline
		}
		m.mu.Unlock()
	}
	return
}

// CleanExpired removes all peers that haven't sent a heartbeat within timeout.
// Returns the IDs of removed peers.
func (m *Map) CleanExpired(timeout time.Duration) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []string
	for id, e := range m.entries {
		if time.Since(e.LastReg) > timeout {
			expired = append(expired, id)
			e.CloseConnections()
			delete(m.entries, id)
		}
	}
	if len(expired) > 0 {
		m.totalExpired.Add(int64(len(expired)))
	}
	return expired
}

// IsOnline returns true if a peer is in the map and not expired.
func (m *Map) IsOnline(id string, timeout time.Duration) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.entries[id]
	if !ok {
		return false
	}
	return !e.IsExpired(timeout)
}

// OnlineStates returns a bitmask of online states for the given peer IDs.
// 1 bit per peer, big-endian bit order within each byte (matching Rust hbbs).
// Bit layout: byte[i/8] bit (7 - i%8) = 1 if peer i is online.
func (m *Map) OnlineStates(ids []string, timeout time.Duration) []byte {
	m.mu.RLock()
	defer m.mu.RUnlock()

	byteCount := (len(ids) + 7) / 8
	states := make([]byte, byteCount)

	for i, id := range ids {
		e, ok := m.entries[id]
		if ok && !e.IsExpired(timeout) {
			statesIdx := i / 8
			bitIdx := uint(7 - i%8)
			states[statesIdx] |= 0x01 << bitIdx
		}
	}
	return states
}

// GetStats computes aggregate statistics for all peers in the map.
func (m *Map) GetStats(degradedThreshold, criticalThreshold int32) Stats {
	m.mu.RLock()
	defer m.mu.RUnlock()

	s := Stats{Total: len(m.entries)}
	var totalUptime, totalBeatAge float64

	for _, e := range m.entries {
		status := e.ComputeStatus(degradedThreshold, criticalThreshold)
		switch status {
		case StatusOnline:
			s.Online++
		case StatusDegraded:
			s.Degraded++
		case StatusCritical:
			s.Critical++
		}

		switch e.ConnType {
		case ConnUDP:
			s.UDP++
		case ConnTCP:
			s.TCP++
		case ConnWS:
			s.WS++
		}

		if e.Banned {
			s.Banned++
		}
		if e.Disabled {
			s.Disabled++
		}

		totalUptime += e.Uptime().Seconds()
		totalBeatAge += e.TimeSinceLastHeartbeat().Seconds()
	}

	if s.Total > 0 {
		s.AvgUptimeSecs = totalUptime / float64(s.Total)
		s.AvgBeatAge = totalBeatAge / float64(s.Total)
	}

	return s
}

// GetSnapshot returns a thread-safe snapshot of a specific peer.
func (m *Map) GetSnapshot(id string, degradedThreshold, criticalThreshold int32) (Snapshot, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.entries[id]
	if !ok {
		return Snapshot{}, false
	}
	return e.Snapshot(degradedThreshold, criticalThreshold), true
}

// GetAllSnapshots returns thread-safe snapshots of all peers.
func (m *Map) GetAllSnapshots(degradedThreshold, criticalThreshold int32) []Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	snapshots := make([]Snapshot, 0, len(m.entries))
	for _, e := range m.entries {
		snapshots = append(snapshots, e.Snapshot(degradedThreshold, criticalThreshold))
	}
	return snapshots
}

// TotalRegistrations returns the cumulative number of peer registrations.
func (m *Map) TotalRegistrations() int64 {
	return m.totalRegistrations.Load()
}

// TotalExpired returns the cumulative number of peers that were cleaned up.
func (m *Map) TotalExpired() int64 {
	return m.totalExpired.Load()
}

// ForEach calls fn for each peer in the map. Do NOT modify the map from fn.
func (m *Map) ForEach(fn func(e *Entry)) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, e := range m.entries {
		fn(e)
	}
}

// normalizePeerAddr produces a canonical "ip:port" for exact endpoint matching.
// IPv4-mapped IPv6 addresses are reduced to IPv4 form (same as signal normalizeAddrKey).
func normalizePeerAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return addr
	}
	if ip4 := ip.To4(); ip4 != nil {
		return net.JoinHostPort(ip4.String(), port)
	}
	return addr
}

// FindByAddr returns the peer whose registered endpoint matches addr exactly
// (ip:port). Used for outbound PunchHole/RequestRelay initiator authorization
// so a pending client behind the same public NAT cannot inherit another peer's
// identity (#302 residual / audit H2).
func (m *Map) FindByAddr(addr *net.UDPAddr) *Entry {
	if addr == nil || addr.IP == nil {
		return nil
	}
	want := normalizePeerAddr(addr.String())
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, e := range m.entries {
		if e.UDPAddr != nil && normalizePeerAddr(e.UDPAddr.String()) == want {
			return e
		}
		if e.IP != "" && normalizePeerAddr(e.IP) == want {
			return e
		}
	}
	return nil
}

// FindByIP returns the first peer whose public IP matches.
// Prefers peers with a UDPAddr; otherwise matches the host portion of entry.IP
// (WebSocket/TCP peers store "ip:port" without UDPAddr). Used when forwarding
// PunchHole/RelayResponse from a decoded socket_addr. If multiple peers share
// the same IP (behind NAT), only the first match is returned — prefer
// exact ip:port maps (tcpPunchConns / wsPunchConns) for initiator delivery (#276).
// Do NOT use bare FindByIP for outbound initiator authorization when multiple
// peers may share a NAT — use FindByAddr or FindAllByIP with a single-match rule (#302).
func (m *Map) FindByIP(ip net.IP) *Entry {
	if ip == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, e := range m.entries {
		if e.UDPAddr != nil && e.UDPAddr.IP.Equal(ip) {
			return e
		}
	}
	// Second pass: WS/TCP peers keyed by IP string only.
	for _, e := range m.entries {
		if e.UDPAddr != nil || e.IP == "" {
			continue
		}
		host, _, err := net.SplitHostPort(e.IP)
		if err != nil {
			host = e.IP
		}
		if parsed := net.ParseIP(host); parsed != nil && parsed.Equal(ip) {
			return e
		}
	}
	return nil
}

// CountByIP returns how many peers share the given public IP (UDPAddr or IP host).
func (m *Map) CountByIP(ip net.IP) int {
	return len(m.FindAllByIP(ip))
}

// FindAllByIP returns every peer whose public IP matches (UDPAddr or IP host).
// Used for outbound initiator auth when exact ip:port is unavailable: a single
// live match can authorize; multiple matches are ambiguous (same-NAT).
func (m *Map) FindAllByIP(ip net.IP) []*Entry {
	if ip == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []*Entry
	for _, e := range m.entries {
		if peerEntryMatchesIP(e, ip) {
			out = append(out, e)
		}
	}
	return out
}

// FindWSByIP returns the first WebSocket peer whose public IP matches.
func (m *Map) FindWSByIP(ip net.IP) *Entry {
	if ip == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, e := range m.entries {
		if e.ConnType != ConnWS || e.WSConn == nil {
			continue
		}
		if peerEntryMatchesIP(e, ip) {
			return e
		}
	}
	return nil
}

// CountWSByIP returns how many WebSocket peers share the given public IP.
func (m *Map) CountWSByIP(ip net.IP) int {
	if ip == nil {
		return 0
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	n := 0
	for _, e := range m.entries {
		if e.ConnType != ConnWS || e.WSConn == nil {
			continue
		}
		if peerEntryMatchesIP(e, ip) {
			n++
		}
	}
	return n
}

func peerEntryMatchesIP(e *Entry, ip net.IP) bool {
	if e == nil || ip == nil {
		return false
	}
	if e.UDPAddr != nil && e.UDPAddr.IP.Equal(ip) {
		return true
	}
	if e.IP == "" {
		return false
	}
	host, _, err := net.SplitHostPort(e.IP)
	if err != nil {
		host = e.IP
	}
	parsed := net.ParseIP(host)
	return parsed != nil && parsed.Equal(ip)
}
