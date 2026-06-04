package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
)

// Engine wraps the shared betterdesk-agent remote-desktop engine.
type Engine struct {
	mu       sync.Mutex
	agent    *bdagent.Agent
	running  bool
	version  string
	onConsent func(sessionID, operator string) bool
	onSessionStart func(sessionID, operator, mode string)
	onSessionEnd   func(sessionID string)
}

// NewEngine creates an engine wrapper.
func NewEngine(version string) *Engine {
	return &Engine{version: version}
}

// SetCallbacks wires UI handlers for consent and session overlay.
func (e *Engine) SetCallbacks(
	onConsent func(sessionID, operator string) bool,
	onSessionStart func(sessionID, operator, mode string),
	onSessionEnd func(sessionID string),
) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onConsent = onConsent
	e.onSessionStart = onSessionStart
	e.onSessionEnd = onSessionEnd
}

func buildConfig(b Branding, st *AppState, version string, handlers *Engine) (*bdagent.Config, error) {
	if !b.HasConnection() {
		return nil, fmt.Errorf("branding has no server address; cannot connect")
	}
	if !st.IsEnrolled() {
		return nil, fmt.Errorf("device not enrolled")
	}

	_, _, _, _ = st.Snapshot()
	st.mu.Lock()
	token := st.DeviceToken
	deviceID := st.DeviceID
	st.mu.Unlock()

	cfg := bdagent.DefaultConfig()
	cfg.Server = b.CDAPWebSocketURL()
	cfg.AuthMethod = "device_token"
	cfg.DeviceToken = token
	cfg.DeviceID = deviceID
	cfg.DeviceType = "os_agent"
	if h, err := os.Hostname(); err == nil && h != "" {
		cfg.DeviceName = h
	}

	cfg.Tags = []string{"support-agent"}
	if IsPortable() {
		cfg.Tags = append(cfg.Tags, "portable")
	} else {
		cfg.Tags = append(cfg.Tags, "installed")
	}
	if b.BundleID != "" {
		cfg.Tags = append(cfg.Tags, "bundle:"+b.BundleID)
	}

	cfg.Screenshot = true
	cfg.Terminal = true
	cfg.Clipboard = true
	cfg.FileBrowser = true
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cfg.FileRoot = home
	}

	_, mode, _, _ := st.Snapshot()
	switch mode {
	case AccessUnattended:
		cfg.RequireConsent = false
	case AccessDisabled:
		cfg.RequireConsent = true
		cfg.Screenshot = false
		cfg.Terminal = false
		cfg.FileBrowser = false
	default:
		cfg.RequireConsent = true
	}

	if strings.HasPrefix(strings.TrimSpace(b.ServerAddress), "https://") || b.useTLS() {
		cfg.EnforceTLS = true
	}
	if tlsInsecureEnabled() && cfg.ServerCertPin == "" {
		cfg.TLSInsecureSkipVerify = true
	}

	if handlers != nil {
		if handlers.onConsent != nil {
			cfg.ConsentHandler = handlers.onConsent
		}
		if handlers.onSessionStart != nil {
			cfg.SessionStartHandler = handlers.onSessionStart
		}
		if handlers.onSessionEnd != nil {
			cfg.SessionEndHandler = handlers.onSessionEnd
		}
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// cdapWSURL builds the CDAP WebSocket URL from branding.
func cdapWSURL(b Branding) string {
	return b.CDAPWebSocketURL()
}

// Start launches the engine when enrolled.
func (e *Engine) Start(st *AppState) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return nil
	}
	if !st.IsEnrolled() {
		return fmt.Errorf("enrollment required before starting engine")
	}

	cfg, err := buildConfig(GetBranding(), st, e.version, e)
	if err != nil {
		return err
	}

	a := bdagent.New(cfg, e.version)
	e.agent = a
	e.running = true

	go func() {
		if err := a.Run(); err != nil {
			log.Printf("[engine] stopped: %v", err)
		}
		e.mu.Lock()
		e.running = false
		e.mu.Unlock()
	}()
	return nil
}

// Stop signals the engine to shut down.
func (e *Engine) Stop() {
	e.mu.Lock()
	a := e.agent
	e.mu.Unlock()
	if a != nil {
		a.Stop()
	}
}

// Running reports whether the engine goroutine is active.
func (e *Engine) Running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

// RequestHelp sends help_request over the active CDAP session.
func (e *Engine) RequestHelp(st *AppState, message string) error {
	e.mu.Lock()
	a := e.agent
	running := e.running
	e.mu.Unlock()
	if !running || a == nil {
		if err := e.Start(st); err != nil {
			return fmt.Errorf("connect to gateway: %w", err)
		}
		for i := 0; i < 40; i++ {
			e.mu.Lock()
			a = e.agent
			e.mu.Unlock()
			if a != nil && a.Connected() {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		e.mu.Lock()
		a = e.agent
		e.mu.Unlock()
	}
	if a == nil {
		return fmt.Errorf("gateway not connected")
	}
	return a.RequestHelp(message)
}
