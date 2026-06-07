package timesync

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

// Status is the last known clock synchronization state.
type Status struct {
	Synced         bool      `json:"synced"`
	OffsetMS       int64     `json:"offset_ms"`
	LastCheckAt    time.Time `json:"last_check_at"`
	NTPServer      string    `json:"ntp_server,omitempty"`
	Stratum        uint8     `json:"stratum,omitempty"`
	MaxSkewMS      int64     `json:"max_skew_ms"`
	RequireSync    bool      `json:"require_sync_for_billing"`
	LastError      string    `json:"last_error,omitempty"`
	OSClockSynced  *bool     `json:"os_clock_synced,omitempty"`
}

// Config controls periodic NTP checks.
type Config struct {
	Servers       []string
	Interval      time.Duration
	QueryTimeout  time.Duration
	MaxSkew       time.Duration
	RequireSync   bool
}

// Service periodically queries NTP and exposes clock health for billing.
type Service struct {
	cfg Config
	db  db.Database

	mu     sync.RWMutex
	status Status

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewService creates a time sync monitor.
func NewService(database db.Database, cfg Config) *Service {
	if len(cfg.Servers) == 0 {
		cfg.Servers = []string{"pool.ntp.org", "time.google.com", "time.cloudflare.com"}
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 60 * time.Second
	}
	if cfg.QueryTimeout <= 0 {
		cfg.QueryTimeout = 5 * time.Second
	}
	if cfg.MaxSkew <= 0 {
		cfg.MaxSkew = 2 * time.Second
	}
	return &Service{
		cfg: cfg,
		db:  database,
		status: Status{
			MaxSkewMS:   cfg.MaxSkew.Milliseconds(),
			RequireSync: cfg.RequireSync,
		},
	}
}

// Start begins periodic NTP checks.
func (s *Service) Start(ctx context.Context) {
	if s.cancel != nil {
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.wg.Add(1)
	go s.loop(runCtx)
	s.CheckNow()
}

// Stop stops background checks.
func (s *Service) Stop() {
	if s.cancel != nil {
		s.cancel()
		s.wg.Wait()
		s.cancel = nil
	}
}

func (s *Service) loop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(s.cfg.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.CheckNow()
		}
	}
}

// CheckNow runs an immediate NTP check against configured servers.
func (s *Service) CheckNow() Status {
	var (
		bestOffset time.Duration
		bestServer string
		bestStratum uint8
		lastErr    error
		found      bool
	)

	for _, server := range s.cfg.Servers {
		offset, stratum, err := QueryNTP(server, s.cfg.QueryTimeout)
		if err != nil {
			lastErr = err
			log.Printf("[timesync] NTP query %s failed: %v", server, err)
			continue
		}
		if !found || absDuration(offset) < absDuration(bestOffset) {
			bestOffset = offset
			bestServer = server
			bestStratum = stratum
			found = true
		}
	}

	st := Status{
		LastCheckAt: time.Now().UTC(),
		MaxSkewMS:   s.cfg.MaxSkew.Milliseconds(),
		RequireSync: s.cfg.RequireSync,
	}
	if osSync := readOSClockSynced(); osSync != nil {
		st.OSClockSynced = osSync
	}

	if !found {
		st.Synced = false
		if lastErr != nil {
			st.LastError = lastErr.Error()
		} else {
			st.LastError = "no NTP servers responded"
		}
		s.setStatus(st)
		s.persistStatus(st)
		return st
	}

	offsetMS := bestOffset.Milliseconds()
	st.OffsetMS = offsetMS
	st.NTPServer = bestServer
	st.Stratum = bestStratum
	st.Synced = absDuration(bestOffset) <= s.cfg.MaxSkew
	if !st.Synced {
		st.LastError = "clock skew exceeds threshold"
	}

	s.setStatus(st)
	s.persistStatus(st)
	if !st.Synced {
		log.Printf("[timesync] WARNING: clock skew %dms (max %dms) via %s",
			offsetMS, s.cfg.MaxSkew.Milliseconds(), bestServer)
	}
	return st
}

func (s *Service) setStatus(st Status) {
	s.mu.Lock()
	s.status = st
	s.mu.Unlock()
}

func (s *Service) persistStatus(st Status) {
	if s.db == nil {
		return
	}
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	_ = s.db.SetConfig("timesync_last_status", string(b))
}

// GetStatus returns the cached synchronization state.
func (s *Service) GetStatus() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

// IsSynced reports whether the server clock is within configured skew.
func (s *Service) IsSynced() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cfg.RequireSync && !s.status.Synced {
		return false
	}
	return s.status.Synced
}

// OffsetAtCheck returns the last measured offset in milliseconds.
func (s *Service) OffsetMS() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status.OffsetMS
}

// NowUTC returns the current UTC time used for billing timestamps.
func (s *Service) NowUTC() time.Time {
	return time.Now().UTC()
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
