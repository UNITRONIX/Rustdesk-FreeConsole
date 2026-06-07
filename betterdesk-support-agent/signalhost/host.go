package signalhost

import (
	"context"
	"sync"
)

// Config holds signal/relay host settings for BetterDesk-compatible clients.
type Config struct {
	SignalAddr string
	RelayAddr  string
	DeviceID   string
	UUID       []byte
	DataDir    string

	Password   func() string
	Unattended func() bool
	TOTPEnabled func() bool
	TOTPVerify  func(code string) bool
	Consent    func(operator string) bool
	OnSession  func(start bool, operator string)
}

// Host maintains UDP registration with hbbs and accepts incoming relay sessions.
type Host struct {
	cfg    Config
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New(cfg Config) *Host {
	return &Host{cfg: cfg}
}

func (h *Host) Start() {
	if h.cfg.SignalAddr == "" || h.cfg.DeviceID == "" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		h.runLoop(ctx)
	}()
}

func (h *Host) Stop() {
	if h.cancel != nil {
		h.cancel()
	}
	h.wg.Wait()
}
