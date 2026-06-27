package timesync

import (
	"testing"
	"time"
)

func TestApplyConfigUpdatesServers(t *testing.T) {
	svc := NewService(nil, Config{
		Servers:     []string{"pool.ntp.org"},
		MaxSkew:     2 * time.Second,
		RequireSync: true,
	})
	svc.ApplyConfig(Config{
		Servers:     []string{"10.0.0.1", "ntp.example.com"},
		MaxSkew:     3 * time.Second,
		RequireSync: false,
		TrustOSNTP:  true,
	})

	svc.mu.RLock()
	defer svc.mu.RUnlock()
	if len(svc.cfg.Servers) != 2 || svc.cfg.Servers[0] != "10.0.0.1" {
		t.Fatalf("servers = %#v", svc.cfg.Servers)
	}
	if svc.cfg.MaxSkew != 3*time.Second {
		t.Fatalf("max skew = %v", svc.cfg.MaxSkew)
	}
	if svc.cfg.RequireSync {
		t.Fatal("expected RequireSync=false")
	}
	if !svc.cfg.TrustOSNTP {
		t.Fatal("expected TrustOSNTP=true")
	}
}

func TestCheckNowTrustOSWhenNTPFails(t *testing.T) {
	old := osClockSyncedReader
	defer func() { osClockSyncedReader = old }()
	synced := true
	osClockSyncedReader = func() *bool { return &synced }

	svc := NewService(nil, Config{
		Servers:      []string{"127.0.0.1:9"},
		QueryTimeout: 100 * time.Millisecond,
		MaxSkew:      2 * time.Second,
		TrustOSNTP:   true,
	})
	st := svc.CheckNow()
	if !st.Synced {
		t.Fatalf("expected synced via OS fallback, got %+v", st)
	}
	if st.NTPServer != "os:systemd-timesyncd" {
		t.Fatalf("ntp_server = %q", st.NTPServer)
	}
	if st.LastError != "" {
		t.Fatalf("last_error = %q", st.LastError)
	}
}

func TestCheckNowNoTrustOSWhenNTPFails(t *testing.T) {
	old := osClockSyncedReader
	defer func() { osClockSyncedReader = old }()
	synced := true
	osClockSyncedReader = func() *bool { return &synced }

	svc := NewService(nil, Config{
		Servers:      []string{"127.0.0.1:9"},
		QueryTimeout: 100 * time.Millisecond,
		MaxSkew:      2 * time.Second,
		TrustOSNTP:   false,
	})
	st := svc.CheckNow()
	if st.Synced {
		t.Fatal("expected unsynced when TrustOSNTP=false")
	}
	if st.LastError == "" {
		t.Fatal("expected last_error")
	}
}
