package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
)

// Engine wraps the shared betterdesk-agent remote-desktop engine so the support
// agent can run it in-process. The same engine powers the full agent client;
// here it is driven entirely by the baked branding plus local AppState.
type Engine struct {
	mu      sync.Mutex
	agent   *bdagent.Agent
	running bool
	version string
}

// NewEngine creates an engine wrapper. version is reported to the server.
func NewEngine(version string) *Engine {
	return &Engine{version: version}
}

// buildConfig assembles the engine configuration from branding + state.
func buildConfig(b Branding, st *AppState, version string) (*bdagent.Config, error) {
	if !b.HasConnection() {
		return nil, fmt.Errorf("branding has no server address; cannot connect")
	}

	cfg := bdagent.DefaultConfig()
	cfg.Server = cdapWSURL(b.ServerAddress)
	cfg.AuthMethod = "api_key"
	cfg.APIKey = b.APIKey
	cfg.DeviceID = st.DeviceID
	cfg.DeviceType = "os_agent"
	if h, err := os.Hostname(); err == nil && h != "" {
		cfg.DeviceName = h
	}

	// Mark the device on the server's device list. The device type must stay
	// "os_agent" (the server validates the type and the panel routes remote
	// sessions on it), so the support-agent identity is carried via tags, which
	// the manifest persists to peer.Tags and the panel shows in its tag column.
	cfg.Tags = []string{"support-agent"}
	if IsPortable() {
		cfg.Tags = append(cfg.Tags, "portable")
	} else {
		cfg.Tags = append(cfg.Tags, "installed")
	}

	// Offer the full RDclient feature set: remote desktop, terminal, clipboard
	// sync and file transfer (file browser). These mirror the capabilities of
	// the full agent client so a supervised quick-help session is not limited.
	cfg.Screenshot = true
	cfg.Terminal = true
	cfg.Clipboard = true
	cfg.FileBrowser = true

	// Root the file browser at the user's home directory so a support operator
	// can transfer the files the user actually needs help with. The engine
	// enforces path-traversal protection relative to this root.
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cfg.FileRoot = home
	}

	// Access policy → consent behaviour.
	switch st.AccessMode {
	case AccessUnattended:
		cfg.RequireConsent = false
	case AccessDisabled:
		// Refuse desktop sessions entirely: keep consent required and disable
		// every interactive capability so no stream or transfer can start.
		cfg.RequireConsent = true
		cfg.Screenshot = false
		cfg.Terminal = false
		cfg.FileBrowser = false
	default: // supervised
		cfg.RequireConsent = true
	}

	if b.ServerKey != "" {
		cfg.ServerCertPin = b.ServerKey
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// cdapWSURL converts a console server address (e.g. https://host:5443) into the
// CDAP gateway WebSocket URL (ws://host:21122/cdap). Mirrors the Rust agent
// client's SidecarConfig::cdap_ws_url so both clients reach the same gateway.
func cdapWSURL(addr string) string {
	const cdapPort = 21122
	addr = strings.TrimSpace(addr)

	withScheme := addr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") &&
		!strings.HasPrefix(addr, "ws://") && !strings.HasPrefix(addr, "wss://") {
		withScheme = "http://" + addr
	}

	wsScheme := "ws"
	if os.Getenv("BETTERDESK_CDAP_TLS") == "1" {
		wsScheme = "wss"
	}

	if u, err := url.Parse(withScheme); err == nil && u.Host != "" {
		host := u.Hostname()
		if host == "" {
			host = "localhost"
		}
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		return fmt.Sprintf("%s://%s:%d/cdap", wsScheme, host, cdapPort)
	}
	return fmt.Sprintf("%s://%s:%d/cdap", wsScheme, addr, cdapPort)
}

// Start launches the engine in a background goroutine using the current
// branding and state. It is a no-op if already running.
func (e *Engine) Start(st *AppState) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return nil
	}

	cfg, err := buildConfig(GetBranding(), st, e.version)
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
