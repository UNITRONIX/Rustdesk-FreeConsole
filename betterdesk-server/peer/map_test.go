package peer

import (
	"net"
	"testing"
	"time"
)

func TestMapPutGet(t *testing.T) {
	m := NewMap()

	e := &Entry{
		ID:      "TEST1",
		PK:      []byte{1, 2, 3},
		IP:      "192.168.1.1:12345",
		LastReg: time.Now(),
	}
	m.Put(e)

	got := m.Get("TEST1")
	if got == nil {
		t.Fatal("expected entry, got nil")
	}
	if got.ID != "TEST1" {
		t.Errorf("ID mismatch: %q", got.ID)
	}
}

func TestMapGetNotFound(t *testing.T) {
	m := NewMap()
	if got := m.Get("NONEXISTENT"); got != nil {
		t.Errorf("expected nil, got %+v", got)
	}
}

func TestMapRemove(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "R1", LastReg: time.Now()})

	removed := m.Remove("R1")
	if removed == nil {
		t.Fatal("expected removed entry")
	}
	if m.Get("R1") != nil {
		t.Error("peer should be gone after remove")
	}
}

func TestMapCount(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "A", LastReg: time.Now()})
	m.Put(&Entry{ID: "B", LastReg: time.Now()})
	m.Put(&Entry{ID: "C", LastReg: time.Now()})

	if m.Count() != 3 {
		t.Errorf("count: got %d, want 3", m.Count())
	}

	m.Remove("B")
	if m.Count() != 2 {
		t.Errorf("count after remove: got %d, want 2", m.Count())
	}
}

func TestMapUpdateHeartbeat(t *testing.T) {
	m := NewMap()
	oldTime := time.Now().Add(-10 * time.Second)
	m.Put(&Entry{ID: "HB1", LastReg: oldTime, Serial: 1})

	addr := &net.UDPAddr{IP: net.ParseIP("10.0.0.1"), Port: 9999}
	ok := m.UpdateHeartbeat("HB1", addr, 5)
	if !ok {
		t.Fatal("UpdateHeartbeat should return true for existing peer")
	}

	e := m.Get("HB1")
	if e.Serial != 5 {
		t.Errorf("serial: got %d, want 5", e.Serial)
	}
	if e.UDPAddr.Port != 9999 {
		t.Errorf("addr port: got %d, want 9999", e.UDPAddr.Port)
	}
	if time.Since(e.LastReg) > time.Second {
		t.Error("LastReg should be recent")
	}

	// Non-existent peer
	if m.UpdateHeartbeat("NOPE", nil, 0) {
		t.Error("UpdateHeartbeat should return false for missing peer")
	}
}

func TestMapCleanExpired(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "FRESH", LastReg: time.Now()})
	m.Put(&Entry{ID: "STALE1", LastReg: time.Now().Add(-30 * time.Second)})
	m.Put(&Entry{ID: "STALE2", LastReg: time.Now().Add(-60 * time.Second)})

	expired := m.CleanExpired(15 * time.Second)
	if len(expired) != 2 {
		t.Errorf("expected 2 expired, got %d: %v", len(expired), expired)
	}
	if m.Count() != 1 {
		t.Errorf("expected 1 remaining, got %d", m.Count())
	}
	if m.Get("FRESH") == nil {
		t.Error("FRESH should still be in map")
	}
}

func TestMapIsOnline(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "ON1", LastReg: time.Now()})
	m.Put(&Entry{ID: "OFF1", LastReg: time.Now().Add(-30 * time.Second)})

	timeout := 15 * time.Second
	if !m.IsOnline("ON1", timeout) {
		t.Error("ON1 should be online")
	}
	if m.IsOnline("OFF1", timeout) {
		t.Error("OFF1 should be offline (expired)")
	}
	if m.IsOnline("NOPE", timeout) {
		t.Error("NOPE should be offline (not in map)")
	}
}

func TestMapOnlineStates(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "A", LastReg: time.Now()})
	m.Put(&Entry{ID: "C", LastReg: time.Now()})
	// B is not in map (offline)

	timeout := 15 * time.Second
	states := m.OnlineStates([]string{"A", "B", "C"}, timeout)

	// 1-bit-per-peer, big-endian bit order (matching Rust hbbs):
	// A (index 0) → bit_idx = 7-0 = 7 → 0x80
	// B (index 1) → offline → 0
	// C (index 2) → bit_idx = 7-2 = 5 → 0x20
	// Expected: byte[0] = 0x80 | 0x20 = 0xA0
	if len(states) < 1 {
		t.Fatalf("expected at least 1 byte, got %d", len(states))
	}
	// A at bit 7: online
	if states[0]&0x80 == 0 {
		t.Errorf("A should be online (bit 7 set), got %02x", states[0])
	}
	// B at bit 6: offline
	if states[0]&0x40 != 0 {
		t.Errorf("B should be offline (bit 6 clear), got %02x", states[0])
	}
	// C at bit 5: online
	if states[0]&0x20 == 0 {
		t.Errorf("C should be online (bit 5 set), got %02x", states[0])
	}
}

func TestMapIDs(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "X", LastReg: time.Now()})
	m.Put(&Entry{ID: "Y", LastReg: time.Now()})

	ids := m.IDs()
	if len(ids) != 2 {
		t.Fatalf("expected 2 IDs, got %d", len(ids))
	}

	found := map[string]bool{}
	for _, id := range ids {
		found[id] = true
	}
	if !found["X"] || !found["Y"] {
		t.Errorf("expected X and Y in IDs, got %v", ids)
	}
}

func TestEntryIsExpired(t *testing.T) {
	fresh := &Entry{LastReg: time.Now()}
	stale := &Entry{LastReg: time.Now().Add(-30 * time.Second)}

	if fresh.IsExpired(15 * time.Second) {
		t.Error("fresh entry should not be expired")
	}
	if !stale.IsExpired(15 * time.Second) {
		t.Error("stale entry should be expired")
	}
}

// Benchmark concurrent access
func BenchmarkMapPutGet(b *testing.B) {
	m := NewMap()
	e := &Entry{ID: "BENCH", LastReg: time.Now()}
	m.Put(e)
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			m.Get("BENCH")
		}
	})
}

func TestEntryComputeStatus(t *testing.T) {
	tests := []struct {
		name     string
		missed   int32
		degraded int32
		critical int32
		want     Status
	}{
		{"online (0 missed)", 0, 2, 4, StatusOnline},
		{"online (1 missed)", 1, 2, 4, StatusOnline},
		{"degraded (2 missed)", 2, 2, 4, StatusDegraded},
		{"degraded (3 missed)", 3, 2, 4, StatusDegraded},
		{"critical (4 missed)", 4, 2, 4, StatusCritical},
		{"critical (10 missed)", 10, 2, 4, StatusCritical},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := &Entry{MissedBeats: tt.missed}
			got := e.ComputeStatus(tt.degraded, tt.critical)
			if got != tt.want {
				t.Errorf("ComputeStatus(missed=%d): got %s, want %s", tt.missed, got, tt.want)
			}
		})
	}
}

func TestEntryUptime(t *testing.T) {
	e := &Entry{FirstSeen: time.Now().Add(-5 * time.Second)}
	uptime := e.Uptime()
	if uptime < 4*time.Second || uptime > 6*time.Second {
		t.Errorf("Uptime: got %v, expected ~5s", uptime)
	}

	zero := &Entry{}
	if zero.Uptime() != 0 {
		t.Error("Zero FirstSeen should return 0 uptime")
	}
}

func TestEntryTimeSinceLastHeartbeat(t *testing.T) {
	e := &Entry{LastReg: time.Now().Add(-3 * time.Second)}
	since := e.TimeSinceLastHeartbeat()
	if since < 2*time.Second || since > 4*time.Second {
		t.Errorf("TimeSinceLastHeartbeat: got %v, expected ~3s", since)
	}
}

func TestEntrySnapshot(t *testing.T) {
	e := &Entry{
		ID:             "SNAP1",
		IP:             "10.0.0.1:1234",
		NATType:        1,
		ConnType:       ConnTCP,
		LastReg:        time.Now(),
		FirstSeen:      time.Now().Add(-60 * time.Second),
		HeartbeatCount: 5,
		MissedBeats:    0,
		Version:        "1.2.3",
		PK:             []byte{1, 2, 3},
		IPHistory:      []string{"10.0.0.2:5678"},
	}

	snap := e.Snapshot(2, 4)

	if snap.ID != "SNAP1" {
		t.Errorf("ID: got %s", snap.ID)
	}
	if snap.Status != StatusOnline {
		t.Errorf("Status: got %s, want ONLINE", snap.Status)
	}
	if snap.ConnType != "tcp" {
		t.Errorf("ConnType: got %s, want tcp", snap.ConnType)
	}
	if snap.HeartbeatCount != 5 {
		t.Errorf("HeartbeatCount: got %d", snap.HeartbeatCount)
	}
	if !snap.HasPK {
		t.Error("HasPK should be true")
	}
	if snap.UptimeSeconds < 59 {
		t.Errorf("UptimeSeconds: got %f, expected ~60", snap.UptimeSeconds)
	}
	if len(snap.IPHistory) != 1 || snap.IPHistory[0] != "10.0.0.2:5678" {
		t.Errorf("IPHistory: got %v", snap.IPHistory)
	}
}

func TestMapCheckHeartbeats(t *testing.T) {
	m := NewMap()

	now := time.Now()
	// Fresh peer — should stay online
	m.Put(&Entry{
		ID:              "FRESH",
		LastReg:         now,
		LastStatusCheck: now.Add(-5 * time.Second),
	})
	// Stale peer — will miss beats
	m.Put(&Entry{
		ID:              "STALE",
		LastReg:         now.Add(-10 * time.Second),
		LastStatusCheck: now.Add(-5 * time.Second),
	})

	degraded, critical := m.CheckHeartbeats(3*time.Second, 2, 4)

	// First check: STALE should get 1 miss (no transition yet)
	if len(degraded) > 0 || len(critical) > 0 {
		// May or may not have transitioned depending on timing
	}

	stale := m.Get("STALE")
	if stale.MissedBeats < 1 {
		t.Errorf("STALE should have at least 1 missed beat, got %d", stale.MissedBeats)
	}

	fresh := m.Get("FRESH")
	if fresh.MissedBeats != 0 {
		t.Errorf("FRESH should have 0 missed beats, got %d", fresh.MissedBeats)
	}
}

func TestMapGetStats(t *testing.T) {
	m := NewMap()

	m.Put(&Entry{ID: "A", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: ConnUDP, MissedBeats: 0})
	m.Put(&Entry{ID: "B", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: ConnTCP, MissedBeats: 3, Banned: true})
	m.Put(&Entry{ID: "C", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: ConnWS, MissedBeats: 5, Disabled: true})

	stats := m.GetStats(2, 4)

	if stats.Total != 3 {
		t.Errorf("Total: got %d, want 3", stats.Total)
	}
	if stats.Online != 1 {
		t.Errorf("Online: got %d, want 1", stats.Online)
	}
	if stats.Degraded != 1 {
		t.Errorf("Degraded: got %d, want 1", stats.Degraded)
	}
	if stats.Critical != 1 {
		t.Errorf("Critical: got %d, want 1", stats.Critical)
	}
	if stats.UDP != 1 || stats.TCP != 1 || stats.WS != 1 {
		t.Errorf("ConnTypes: UDP=%d TCP=%d WS=%d", stats.UDP, stats.TCP, stats.WS)
	}
	if stats.Banned != 1 {
		t.Errorf("Banned: got %d, want 1", stats.Banned)
	}
	if stats.Disabled != 1 {
		t.Errorf("Disabled: got %d, want 1", stats.Disabled)
	}
}

func TestMapGetSnapshot(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "S1", LastReg: time.Now(), FirstSeen: time.Now()})

	snap, ok := m.GetSnapshot("S1", 2, 4)
	if !ok {
		t.Fatal("GetSnapshot should find peer S1")
	}
	if snap.ID != "S1" {
		t.Errorf("ID: got %s", snap.ID)
	}

	_, ok = m.GetSnapshot("NOPE", 2, 4)
	if ok {
		t.Error("GetSnapshot should not find NOPE")
	}
}

func TestMapGetAllSnapshots(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{ID: "X", LastReg: time.Now(), FirstSeen: time.Now()})
	m.Put(&Entry{ID: "Y", LastReg: time.Now(), FirstSeen: time.Now()})

	snaps := m.GetAllSnapshots(2, 4)
	if len(snaps) != 2 {
		t.Fatalf("expected 2 snapshots, got %d", len(snaps))
	}
}

func TestMapUpdateHeartbeatIPHistory(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{
		ID:      "ROAM",
		IP:      "1.1.1.1:100",
		LastReg: time.Now(),
		UDPAddr: &net.UDPAddr{IP: net.ParseIP("1.1.1.1"), Port: 100},
	})

	// Heartbeat from new IP
	newAddr := &net.UDPAddr{IP: net.ParseIP("2.2.2.2"), Port: 200}
	m.UpdateHeartbeat("ROAM", newAddr, 2)

	e := m.Get("ROAM")
	if len(e.IPHistory) != 1 || e.IPHistory[0] != "1.1.1.1:100" {
		t.Errorf("IPHistory: got %v, want [1.1.1.1:100]", e.IPHistory)
	}
	if e.IP != "2.2.2.2:200" {
		t.Errorf("IP: got %s, want 2.2.2.2:200", e.IP)
	}
	if e.HeartbeatCount != 1 {
		t.Errorf("HeartbeatCount: got %d, want 1", e.HeartbeatCount)
	}
	if e.MissedBeats != 0 {
		t.Errorf("MissedBeats: got %d, want 0", e.MissedBeats)
	}
}

func TestMapTotalCounters(t *testing.T) {
	m := NewMap()

	if m.TotalRegistrations() != 0 {
		t.Errorf("TotalRegistrations: got %d, want 0", m.TotalRegistrations())
	}

	m.Put(&Entry{ID: "A", LastReg: time.Now()})
	m.Put(&Entry{ID: "B", LastReg: time.Now()})

	if m.TotalRegistrations() != 2 {
		t.Errorf("TotalRegistrations: got %d, want 2", m.TotalRegistrations())
	}

	// Re-put same peer shouldn't increment
	m.Put(&Entry{ID: "A", LastReg: time.Now()})
	if m.TotalRegistrations() != 2 {
		t.Errorf("TotalRegistrations after re-put: got %d, want 2", m.TotalRegistrations())
	}

	// CleanExpired should track expired count
	m.Put(&Entry{ID: "X", LastReg: time.Now().Add(-60 * time.Second)})
	m.CleanExpired(15 * time.Second)
	if m.TotalExpired() != 1 {
		t.Errorf("TotalExpired: got %d, want 1", m.TotalExpired())
	}
}

func TestConnTypeString(t *testing.T) {
	tests := []struct {
		ct   ConnType
		want string
	}{
		{ConnUDP, "udp"},
		{ConnTCP, "tcp"},
		{ConnWS, "ws"},
		{ConnType(99), "unknown"},
	}
	for _, tt := range tests {
		if got := tt.ct.String(); got != tt.want {
			t.Errorf("ConnType(%d).String(): got %s, want %s", tt.ct, got, tt.want)
		}
	}
}

func TestFindByIPMatchesWSPeerIPString(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{
		ID:       "WS1",
		IP:       "203.0.113.50:50123",
		ConnType: ConnWS,
		LastReg:  time.Now(),
	})
	m.Put(&Entry{
		ID:       "UDP1",
		IP:       "198.51.100.1:21116",
		UDPAddr:  &net.UDPAddr{IP: net.ParseIP("198.51.100.1"), Port: 21116},
		ConnType: ConnUDP,
		LastReg:  time.Now(),
	})

	got := m.FindByIP(net.ParseIP("203.0.113.50"))
	if got == nil || got.ID != "WS1" {
		t.Fatalf("FindByIP WS peer = %+v, want WS1", got)
	}
	got = m.FindByIP(net.ParseIP("198.51.100.1"))
	if got == nil || got.ID != "UDP1" {
		t.Fatalf("FindByIP UDP peer = %+v, want UDP1", got)
	}
	if m.FindByIP(nil) != nil {
		t.Fatal("FindByIP(nil) should be nil")
	}
}

func TestCountWSByIPAndFindWSByIP(t *testing.T) {
	m := NewMap()
	m.Put(&Entry{
		ID:       "WS1",
		IP:       "203.0.113.50:50123",
		ConnType: ConnWS,
		WSConn:   struct{}{}, // non-nil marker
		LastReg:  time.Now(),
	})
	m.Put(&Entry{
		ID:       "WS2",
		IP:       "203.0.113.50:50124",
		ConnType: ConnWS,
		WSConn:   struct{}{},
		LastReg:  time.Now(),
	})
	m.Put(&Entry{
		ID:       "UDP1",
		IP:       "203.0.113.50:21116",
		UDPAddr:  &net.UDPAddr{IP: net.ParseIP("203.0.113.50"), Port: 21116},
		ConnType: ConnUDP,
		LastReg:  time.Now(),
	})

	ip := net.ParseIP("203.0.113.50")
	if got := m.CountByIP(ip); got != 3 {
		t.Fatalf("CountByIP = %d, want 3", got)
	}
	if got := m.CountWSByIP(ip); got != 2 {
		t.Fatalf("CountWSByIP = %d, want 2", got)
	}
	if got := m.FindWSByIP(ip); got == nil || (got.ID != "WS1" && got.ID != "WS2") {
		t.Fatalf("FindWSByIP = %+v, want WS1 or WS2", got)
	}
}
