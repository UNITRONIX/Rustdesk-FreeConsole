package signalhost

import (
	"context"
	"net"
	"sync"
)

// Config holds signal/relay host settings for BetterDesk-compatible clients.
type Config struct {
	SignalAddr string
	RelayAddr  string
	DeviceID   string
	UUID       []byte
	DataDir    string

	Password    func() string
	Unattended  func() bool
	TOTPEnabled func() bool
	TOTPVerify  func(code string) bool
	// AccessAllowed must return false as soon as local policy disables
	// RustDesk-compatible desktop access.
	AccessAllowed  func() bool
	DesktopEnabled bool
	AudioEnabled   bool
	RestartEnabled bool
	// Consent must be provided whenever Unattended returns false. A missing
	// callback is treated as denial rather than an unattended fallback.
	Consent   func(operator string) bool
	OnSession func(start bool, operator string)
}

// Host maintains UDP registration with hbbs and accepts incoming relay sessions.
type Host struct {
	cfg Config

	mu       sync.Mutex
	cancel   context.CancelFunc
	running  bool
	identity *identity
	auth     *authenticationLimiter
	wg       sync.WaitGroup

	sessionsMu sync.Mutex
	sessions   map[net.Conn]struct{}
}

func New(cfg Config) *Host {
	return &Host{
		cfg:  cfg,
		auth: newAuthenticationLimiter(nil),
	}
}

// Start begins outbound rendezvous registration. It never opens a local
// listener; relay sessions are initiated only after the rendezvous service
// requests one.
func (h *Host) Start() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running {
		return true
	}
	if h.cfg.SignalAddr == "" || h.cfg.DeviceID == "" || !h.accessAllowed() {
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.running = true
	h.sessions = make(map[net.Conn]struct{})
	h.wg.Add(1)
	go func() {
		defer func() {
			h.mu.Lock()
			h.running = false
			h.cancel = nil
			h.mu.Unlock()
			h.DisconnectSessions()
			h.wg.Done()
		}()
		h.runLoop(ctx)
	}()
	return true
}

func (h *Host) Stop() {
	h.mu.Lock()
	cancel := h.cancel
	h.cancel = nil
	h.running = false
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	h.DisconnectSessions()
	h.wg.Wait()
}

// DisconnectSessions terminates currently active relay sessions without
// unregistering the host. It is used by the local "Disconnect" action.
func (h *Host) DisconnectSessions() {
	h.sessionsMu.Lock()
	conns := make([]net.Conn, 0, len(h.sessions))
	for conn := range h.sessions {
		conns = append(conns, conn)
	}
	h.sessions = make(map[net.Conn]struct{})
	h.sessionsMu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// Running reports whether rendezvous registration is active.
func (h *Host) Running() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.running
}

func (h *Host) setIdentity(identity *identity) {
	h.mu.Lock()
	h.identity = identity
	h.mu.Unlock()
}

func (h *Host) hostIdentity() *identity {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.identity
}

func (h *Host) accessAllowed() bool {
	return h.cfg.DesktopEnabled && (h.cfg.AccessAllowed == nil || h.cfg.AccessAllowed())
}

func (h *Host) trackRelay(conn net.Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.running || !h.accessAllowed() {
		return false
	}
	h.sessionsMu.Lock()
	h.sessions[conn] = struct{}{}
	h.sessionsMu.Unlock()
	return true
}

func (h *Host) untrackRelay(conn net.Conn) {
	h.sessionsMu.Lock()
	delete(h.sessions, conn)
	h.sessionsMu.Unlock()
}
