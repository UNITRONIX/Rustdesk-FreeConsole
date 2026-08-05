package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
)

var errRemoteAccessDisabled = errors.New("remote access is disabled by local policy")

// Engine wraps the shared betterdesk-agent remote-desktop engine.
type Engine struct {
	mu                sync.Mutex
	agent             *bdagent.Agent
	running           bool
	version           string
	onConsent         func(sessionID, operator string) bool
	onSessionStart    func(sessionID, operator, mode string)
	onSessionEnd      func(sessionID string)
	onChat            func(from, text string)
	sessionAuthorizer *passiveSessionAuthorizer
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
	policy := accessPolicyFor(b, st)
	if policy.mode == AccessDisabled {
		// Do not keep a CDAP registration alive merely to reject individual
		// requests. AccessDisabled is an explicit local opt-out for both
		// incoming transports.
		return nil, errRemoteAccessDisabled
	}

	st.mu.Lock()
	token := st.DeviceToken
	deviceID := st.DeviceID
	st.mu.Unlock()

	cfg := bdagent.DefaultConfig()
	cdapWS, _ := PickWorkingCDAP(b, st)
	cfg.Server = cdapWS
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

	caps := policy.capabilities
	cfg.Screenshot = caps.Desktop
	cfg.Terminal = caps.Terminal
	cfg.Clipboard = caps.Clipboard
	cfg.FileBrowser = caps.Files
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cfg.FileRoot = home
	}

	cfg.RequireConsent = policy.requiresConsent()

	if strings.HasPrefix(strings.TrimSpace(b.ServerAddress), "https://") || b.useTLS() {
		cfg.EnforceTLS = true
	}
	if b.Server != nil {
		cfg.ServerCertPin = strings.TrimSpace(b.Server.CertPin)
	}
	if tlsInsecureEnabled() && cfg.ServerCertPin == "" {
		cfg.TLSInsecureSkipVerify = true
	}

	if handlers != nil {
		authorizer := handlers.sessionAuthorizer
		if handlers.onConsent != nil {
			cfg.ConsentHandler = func(sessionID, operator string) bool {
				granted := handlers.onConsent(sessionID, operator)
				if authorizer != nil {
					authorizer.ResolveConsent(sessionID, granted)
				}
				return granted
			}
		}
		if authorizer != nil {
			requireConsent := policy.requiresConsent()
			cfg.SessionAuthorizeHandler = func(sessionID, operator, transport string, capabilities []string, grant string) error {
				return authorizer.Authorize(sessionID, operator, transport, capabilities, grant, requireConsent)
			}
		}
		if handlers.onSessionStart != nil {
			cfg.SessionStartHandler = handlers.onSessionStart
		}
		if handlers.onSessionEnd != nil {
			cfg.SessionEndHandler = func(sessionID string) {
				if authorizer != nil {
					authorizer.End(sessionID)
				}
				handlers.onSessionEnd(sessionID)
			}
		}
		if handlers.onChat != nil {
			cfg.ChatMessageHandler = handlers.onChat
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
	if e.sessionAuthorizer == nil {
		authorizer, err := newPassiveSessionAuthorizer(GetBranding(), st)
		if err != nil {
			return err
		}
		e.sessionAuthorizer = authorizer
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

// Restart applies a changed local access policy after the active agent exits.
// Waiting for the old Run loop avoids racing a fresh configuration against an
// agent that is still connected with the previous permissions.
func (e *Engine) Restart(st *AppState) error {
	e.Stop()

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for e.Running() {
		select {
		case <-deadline.C:
			return fmt.Errorf("remote engine did not stop after access policy change")
		case <-ticker.C:
		}
	}
	e.mu.Lock()
	e.sessionAuthorizer = nil
	e.mu.Unlock()
	return e.Start(st)
}

// Running reports whether the engine goroutine is active.
func (e *Engine) Running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

// SendChat sends a chat message when the engine is running.
func (e *Engine) SendChat(text string) error {
	e.mu.Lock()
	a := e.agent
	e.mu.Unlock()
	if a == nil {
		return fmt.Errorf("gateway not connected")
	}
	return a.SendChat(text)
}

// SetChatHandler wires incoming chat messages to the UI.
func (e *Engine) SetChatHandler(fn func(from, text string)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onChat = fn
}

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
