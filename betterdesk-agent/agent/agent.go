package agent

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Message is the CDAP protocol envelope (mirrors server-side cdap.Message).
type Message struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Timestamp string          `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload"`
}

// Agent connects to a BetterDesk CDAP gateway, authenticates, registers
// a system manifest, and handles commands / media sessions.
type Agent struct {
	cfg     *Config
	version string

	conn *websocket.Conn
	mu   sync.Mutex // serialise writes

	// Auth state
	token     string
	deviceID  string
	role      string
	sessionID string

	// Session managers
	terminals      sync.Map // session_id → *TerminalSession
	fileHandlers   sync.Map // session_id → context.CancelFunc
	desktopStreams sync.Map // session_id → *DesktopStreamer
	audioStreams   sync.Map // session_id → *AudioStreamer

	// Consent system: when require_consent=true, handleDesktopStart prints
	// CONSENT_REQUEST to stdout and waits on a channel stored here.
	// The Tauri wrapper reads stdout, shows a dialog, then writes
	// CONSENT_GRANTED / CONSENT_DENIED to stdin.
	consentWaiters sync.Map // session_id → chan bool

	// System modules
	sysCollector *SystemCollector
	clipboard    *ClipboardHandler

	// Widget values collected per heartbeat cycle
	widgetValues sync.Map // widget_id → any

	// Lifecycle
	connected atomic.Bool
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// New creates a new Agent with the supplied configuration.
func New(cfg *Config, version string) *Agent {
	ctx, cancel := context.WithCancel(context.Background())
	return &Agent{
		cfg:          cfg,
		version:      version,
		sysCollector: NewSystemCollector(),
		clipboard:    NewClipboardHandler(),
		ctx:          ctx,
		cancel:       cancel,
	}
}

// Run starts the agent with automatic reconnect on disconnect.
func (a *Agent) Run() error {
	delay := time.Duration(a.cfg.ReconnectSec) * time.Second
	maxDelay := time.Duration(a.cfg.MaxReconnect) * time.Second

	// Start stdin reader for consent responses when running as a Tauri sidecar.
	// The Tauri wrapper writes "CONSENT_GRANTED:<session_id>" or
	// "CONSENT_DENIED:<session_id>" to our stdin after showing the UI dialog.
	if a.cfg.RequireConsent {
		go a.stdinConsentReader()
	}

	for {
		select {
		case <-a.ctx.Done():
			return nil
		default:
		}
		err := a.runOnce()
		if err != nil {
			log.Printf("[agent] Connection lost: %v", err)
		} else {
			delay = time.Duration(a.cfg.ReconnectSec) * time.Second
		}

		// Exponential backoff with jitter
		jitter := time.Duration(rand.Int63n(max(int64(delay/4), 1)))
		wait := delay + jitter
		log.Printf("[agent] Reconnecting in %v...", wait)

		select {
		case <-a.ctx.Done():
			return nil
		case <-time.After(wait):
		}
		delay = min(delay*2, maxDelay)
	}
}

// Connected reports whether the agent has an active CDAP session.
func (a *Agent) Connected() bool {
	return a.connected.Load()
}

// Stop signals the agent to shut down gracefully.
func (a *Agent) Stop() {
	a.cancel()
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn != nil {
		conn.Close(websocket.StatusNormalClosure, "agent shutdown")
	}
	a.wg.Wait()
}

// ── Single connection lifecycle ──────────────────────────────────────

// dialOptions builds the WebSocket dial options, including a hardened TLS
// configuration for wss:// connections: optional public-key pinning
// (ServerCertPin) and optional self-signed acceptance (TLSInsecureSkipVerify).
// Returns nil for plaintext ws:// (no TLS layer involved).
func (a *Agent) dialOptions() *websocket.DialOptions {
	if !strings.HasPrefix(a.cfg.Server, "wss://") {
		return nil
	}

	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	switch {
	case a.cfg.ServerCertPin != "":
		// Pinned mode: skip the default chain check and verify the leaf
		// public key against the configured SPKI SHA-256. This defeats MITM
		// even when a rogue CA is trusted by the system store.
		tlsCfg.InsecureSkipVerify = true
		pin := a.cfg.ServerCertPin
		tlsCfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("tls: server presented no certificate")
			}
			leaf, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return fmt.Errorf("tls: parse leaf certificate: %w", err)
			}
			sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
			got := hex.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(got), []byte(pin)) != 1 {
				return fmt.Errorf("tls: server public-key pin mismatch (expected %s, got %s)", pin, got)
			}
			return nil
		}
	case a.cfg.TLSInsecureSkipVerify:
		// Explicit opt-out: accept self-signed without verification.
		tlsCfg.InsecureSkipVerify = true
	}

	return &websocket.DialOptions{
		HTTPClient: &http.Client{
			Transport: &http.Transport{TLSClientConfig: tlsCfg},
		},
	}
}

func (a *Agent) runOnce() error {
	log.Printf("[agent] Connecting to %s...", a.cfg.Server)

	dialCtx, dialCancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer dialCancel()

	conn, _, err := websocket.Dial(dialCtx, a.cfg.Server, a.dialOptions())
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	conn.SetReadLimit(4 * 1024 * 1024) // 4MB max message

	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()

	// Authenticate
	if err := a.authenticate(); err != nil {
		conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return fmt.Errorf("auth: %w", err)
	}

	// Register manifest
	if err := a.register(); err != nil {
		conn.Close(websocket.StatusInternalError, "register failed")
		return fmt.Errorf("register: %w", err)
	}

	a.connected.Store(true)
	log.Printf("[agent] Connected as %q (device_id=%s, role=%s)", a.cfg.DeviceName, a.deviceID, a.role)

	// Start heartbeat sender
	a.wg.Add(1)
	go a.heartbeatLoop()

	// Blocking message loop
	err = a.messageLoop()

	a.connected.Store(false)
	a.cleanupSessions()
	a.wg.Wait()
	return err
}

// ── Authentication ───────────────────────────────────────────────────

func (a *Agent) authenticate() error {
	payload := map[string]string{
		"method":         a.cfg.AuthMethod,
		"device_id":      a.cfg.DeviceID,
		"client_version": a.version,
	}
	switch a.cfg.AuthMethod {
	case "api_key":
		payload["key"] = a.cfg.APIKey
	case "device_token":
		payload["token"] = a.cfg.DeviceToken
	case "user_password":
		payload["username"] = a.cfg.Username
		payload["password"] = a.cfg.Password
	}

	if err := a.sendMessage("auth", payload); err != nil {
		return err
	}

	msg, err := a.readMessage()
	if err != nil {
		return err
	}
	if msg.Type != "auth_result" {
		return fmt.Errorf("expected auth_result, got %s", msg.Type)
	}

	var result struct {
		Success     bool   `json:"success"`
		Token       string `json:"token"`
		Role        string `json:"role"`
		DeviceID    string `json:"device_id"`
		SessionTok  string `json:"session_token"`
		Requires2FA bool   `json:"requires_2fa"`
		Error       string `json:"error"`
	}
	if err := json.Unmarshal(msg.Payload, &result); err != nil {
		return fmt.Errorf("parse auth_result: %w", err)
	}
	if !result.Success {
		return fmt.Errorf("auth rejected: %s", result.Error)
	}
	a.token = result.Token
	a.deviceID = result.DeviceID
	a.role = result.Role
	a.sessionID = result.SessionTok
	return nil
}

// ── Registration ─────────────────────────────────────────────────────

func (a *Agent) register() error {
	manifest := BuildManifest(a.cfg, a.sysCollector, a.version)
	return a.sendMessage("register", map[string]any{"manifest": manifest})
}

// ── Heartbeat ────────────────────────────────────────────────────────

func (a *Agent) heartbeatLoop() {
	defer a.wg.Done()
	ticker := time.NewTicker(time.Duration(a.cfg.HeartbeatSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			if !a.connected.Load() {
				return
			}
			metrics := a.sysCollector.Collect()
			info := a.sysCollector.GetInfo()

			// Map system metrics to widget IDs for server-side state tracking.
			a.widgetValues.Store("sys_cpu", metrics.CPU)
			a.widgetValues.Store("sys_memory", metrics.Memory)
			a.widgetValues.Store("sys_disk", metrics.Disk)
			a.widgetValues.Store("sys_hostname", info.Hostname)
			a.widgetValues.Store("sys_uptime", formatUptime(a.sysCollector.Uptime()))

			wv := a.collectWidgetValues()
			payload := map[string]any{"metrics": metrics}
			if len(wv) > 0 {
				payload["widget_values"] = wv
			}
			if err := a.sendMessage("heartbeat", payload); err != nil {
				log.Printf("[agent] Heartbeat failed: %v", err)
				return
			}
		}
	}
}

func (a *Agent) collectWidgetValues() map[string]any {
	vals := make(map[string]any)
	a.widgetValues.Range(func(k, v any) bool {
		vals[k.(string)] = v
		return true
	})
	return vals
}

func formatUptime(secs uint64) string {
	d := secs / 86400
	h := (secs % 86400) / 3600
	m := (secs % 3600) / 60
	if d > 0 {
		return fmt.Sprintf("%dd %dh %dm", d, h, m)
	}
	return fmt.Sprintf("%dh %dm", h, m)
}

// ── Message Loop & Dispatch ──────────────────────────────────────────

func (a *Agent) messageLoop() error {
	for {
		msg, err := a.readMessage()
		if err != nil {
			return err
		}
		a.dispatch(msg)
	}
}

func (a *Agent) dispatch(msg *Message) {
	switch msg.Type {

	// ── Commands ──
	case "command":
		a.handleCommand(msg)

	// ── Terminal ──
	case "terminal_start":
		a.handleTerminalStart(msg)
	case "terminal_data":
		a.handleTerminalInput(msg)
	case "terminal_resize":
		a.handleTerminalResize(msg)

	// ── File Browser ──
	case "file_start":
		// Session acknowledged — nothing to do on agent side
	case "file_list":
		a.handleFileList(msg)
	case "file_read":
		a.handleFileRead(msg)
	case "file_write":
		a.handleFileWrite(msg)
	case "file_delete":
		a.handleFileDelete(msg)

	// ── Clipboard ──
	case "clipboard_set":
		a.handleClipboardSet(msg)
	case "clipboard_get":
		a.handleClipboardGet(msg)

	// ── Desktop (Screenshot + Streaming) ──
	case "desktop_start":
		a.handleDesktopStart(msg)
	case "desktop_stop", "desktop_end":
		a.handleDesktopStop(msg)
	case "desktop_input":
		a.handleDesktopInput(msg)

	// ── Video / Audio ──
	case "audio_start":
		a.handleAudioStart(msg)
	case "audio_stop":
		a.handleAudioStop(msg)
	case "video_start", "audio_input":
		log.Printf("[agent] %s: not supported in os_agent mode", msg.Type)

	// ── Codec / Media Control ──
	case "codec_offer":
		a.handleCodecOffer(msg)
	case "monitor_select":
		a.handleMonitorSelect(msg)
	case "keyframe_request", "key_exchange", "quality_adjust":
		// Acknowledged — no real-time media to adjust

	// ── Errors ──
	case "error":
		var ep struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		json.Unmarshal(msg.Payload, &ep)
		log.Printf("[agent] Server error %d: %s", ep.Code, ep.Message)

	default:
		if a.cfg.LogLevel == "debug" {
			log.Printf("[agent] Unknown message: %s", msg.Type)
		}
	}
}

// ── Command Handling ─────────────────────────────────────────────────

func (a *Agent) handleCommand(msg *Message) {
	var cmd struct {
		CommandID string `json:"command_id"`
		WidgetID  string `json:"widget_id"`
		Action    string `json:"action"`
		Value     any    `json:"value"`
	}
	if err := json.Unmarshal(msg.Payload, &cmd); err != nil {
		return
	}

	go func() {
		start := time.Now()
		result, err := a.executeWidgetCommand(cmd.WidgetID, cmd.Action, cmd.Value)
		resp := map[string]any{
			"command_id":        cmd.CommandID,
			"execution_time_ms": time.Since(start).Milliseconds(),
		}
		if err != nil {
			resp["status"] = "error"
			resp["error_message"] = err.Error()
		} else {
			resp["status"] = "ok"
			resp["result"] = result
		}
		a.sendMessage("command_response", resp)
	}()
}

func (a *Agent) executeWidgetCommand(widgetID, action string, value any) (any, error) {
	switch widgetID {
	case "sys_screenshot":
		if action == "trigger" {
			return a.captureAndSendScreenshot()
		}
	case "sys_clipboard":
		if action == "query" {
			text := a.clipboard.Get()
			return map[string]string{"text": text}, nil
		}
		if action == "set" {
			if s, ok := value.(string); ok {
				a.clipboard.Set(s)
				return "ok", nil
			}
		}
	}

	// Generic widget — store the value
	if action == "set" {
		a.widgetValues.Store(widgetID, value)
		return "ok", nil
	}
	if action == "query" {
		if v, ok := a.widgetValues.Load(widgetID); ok {
			return v, nil
		}
		return nil, nil
	}

	return nil, fmt.Errorf("unsupported action %q on widget %q", action, widgetID)
}

// ── Terminal Handlers ────────────────────────────────────────────────

func (a *Agent) handleTerminalStart(msg *Message) {
	if !a.cfg.Terminal {
		log.Printf("[agent] Terminal disabled, ignoring terminal_start")
		return
	}
	var p struct {
		SessionID string `json:"session_id"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
		Shell     string `json:"shell"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	if p.Cols <= 0 {
		p.Cols = 80
	}
	if p.Rows <= 0 {
		p.Rows = 24
	}

	ts, err := StartTerminal(p.SessionID, p.Cols, p.Rows, p.Shell, func(data []byte) {
		a.sendMessage("terminal_output", map[string]any{
			"session_id": p.SessionID,
			"data":       string(data),
			"stream":     "stdout",
		})
	})
	if err != nil {
		log.Printf("[agent] Terminal start failed: %v", err)
		a.sendMessage("terminal_end", map[string]any{
			"session_id": p.SessionID,
			"reason":     "start_failed",
		})
		return
	}
	a.terminals.Store(p.SessionID, ts)
}

func (a *Agent) handleTerminalInput(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	if ts, ok := a.terminals.Load(p.SessionID); ok {
		ts.(*TerminalSession).Write([]byte(p.Data))
	}
}

func (a *Agent) handleTerminalResize(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	if ts, ok := a.terminals.Load(p.SessionID); ok {
		ts.(*TerminalSession).Resize(p.Cols, p.Rows)
	}
}

// ── File Browser Handlers ────────────────────────────────────────────

func (a *Agent) handleFileList(msg *Message) {
	if !a.cfg.FileBrowser {
		return
	}
	var p struct {
		SessionID string `json:"session_id"`
		RequestID string `json:"request_id"`
		Path      string `json:"path"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	go func() {
		entries, err := ListDirectory(a.cfg.FileRoot, p.Path)
		resp := map[string]any{
			"session_id": p.SessionID,
			"request_id": p.RequestID,
			"path":       p.Path,
		}
		if err != nil {
			resp["error"] = err.Error()
			resp["entries"] = []any{}
		} else {
			resp["entries"] = entries
		}
		a.sendMessage("file_list_response", resp)
	}()
}

func (a *Agent) handleFileRead(msg *Message) {
	if !a.cfg.FileBrowser {
		return
	}
	var p struct {
		SessionID string `json:"session_id"`
		RequestID string `json:"request_id"`
		Path      string `json:"path"`
		Offset    int64  `json:"offset"`
		Length    int64  `json:"length"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	go func() {
		data, size, done, err := ReadFileChunk(a.cfg.FileRoot, p.Path, p.Offset, p.Length)
		resp := map[string]any{
			"session_id": p.SessionID,
			"request_id": p.RequestID,
			"path":       p.Path,
			"offset":     p.Offset,
			"done":       done,
		}
		if err != nil {
			resp["error"] = err.Error()
			resp["data"] = ""
			resp["size"] = int64(0)
		} else {
			resp["data"] = base64.StdEncoding.EncodeToString(data)
			resp["size"] = size
		}
		a.sendMessage("file_read_response", resp)
	}()
}

func (a *Agent) handleFileWrite(msg *Message) {
	if !a.cfg.FileBrowser {
		return
	}
	var p struct {
		SessionID string `json:"session_id"`
		RequestID string `json:"request_id"`
		Path      string `json:"path"`
		Data      string `json:"data"` // base64
		Offset    int64  `json:"offset"`
		Done      bool   `json:"done"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	go func() {
		raw, err := base64.StdEncoding.DecodeString(p.Data)
		resp := map[string]any{
			"session_id": p.SessionID,
			"request_id": p.RequestID,
			"path":       p.Path,
		}
		if err != nil {
			resp["error"] = "invalid base64 data"
			resp["written"] = int64(0)
		} else {
			written, writeErr := WriteFileChunk(a.cfg.FileRoot, p.Path, p.Offset, raw)
			resp["written"] = written
			if writeErr != nil {
				resp["error"] = writeErr.Error()
			}
		}
		a.sendMessage("file_write_response", resp)
	}()
}

func (a *Agent) handleFileDelete(msg *Message) {
	if !a.cfg.FileBrowser {
		return
	}
	var p struct {
		SessionID string `json:"session_id"`
		RequestID string `json:"request_id"`
		Path      string `json:"path"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	go func() {
		err := DeletePath(a.cfg.FileRoot, p.Path)
		resp := map[string]any{
			"session_id": p.SessionID,
			"request_id": p.RequestID,
			"path":       p.Path,
		}
		if err != nil {
			resp["error"] = err.Error()
		}
		a.sendMessage("file_delete_response", resp)
	}()
}

// ── Clipboard Handler ────────────────────────────────────────────────

func (a *Agent) handleClipboardSet(msg *Message) {
	if !a.cfg.Clipboard {
		return
	}
	var p struct {
		Format string `json:"format"`
		Data   string `json:"data"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	if p.Format == "text" {
		a.clipboard.Set(p.Data)
	}
}

// handleClipboardGet responds with the current clipboard text contents.
// Capability gated by cfg.Clipboard; no-op (with short error response) when
// disabled so the operator UI can show a meaningful state.
func (a *Agent) handleClipboardGet(msg *Message) {
	var p struct {
		RequestID string `json:"request_id"`
	}
	_ = json.Unmarshal(msg.Payload, &p)

	resp := map[string]any{
		"request_id": p.RequestID,
		"format":     "text",
	}

	if !a.cfg.Clipboard {
		resp["error"] = "clipboard capability disabled"
		resp["data"] = ""
		a.sendMessage("clipboard_data", resp)
		return
	}

	resp["data"] = a.clipboard.Get()
	a.sendMessage("clipboard_data", resp)
}

// ── Session Cleanup ──────────────────────────────────────────────────

func (a *Agent) cleanupSessions() {
	a.terminals.Range(func(key, value any) bool {
		value.(*TerminalSession).Close()
		a.terminals.Delete(key)
		return true
	})
	a.fileHandlers.Range(func(key, value any) bool {
		if cancel, ok := value.(context.CancelFunc); ok {
			cancel()
		}
		a.fileHandlers.Delete(key)
		return true
	})
	a.desktopStreams.Range(func(key, value any) bool {
		value.(*DesktopStreamer).Stop()
		a.desktopStreams.Delete(key)
		return true
	})
}

// ── Wire I/O ─────────────────────────────────────────────────────────

func (a *Agent) sendMessage(msgType string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	envelope := Message{
		Type:      msgType,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil {
		return fmt.Errorf("no connection")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	return a.conn.Write(ctx, websocket.MessageText, raw)
}

// sendBinary writes a raw binary WebSocket frame on the agent's CDAP
// connection. Used by high-throughput media paths (e.g. desktop JPEG
// frames) where the per-message JSON+base64 cost is the bottleneck.
// Callers must encode any framing they need (e.g. a session ID prefix)
// directly inside the data buffer.
func (a *Agent) sendBinary(data []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil {
		return fmt.Errorf("no connection")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	return a.conn.Write(ctx, websocket.MessageBinary, data)
}

func (a *Agent) readMessage() (*Message, error) {
	_, data, err := a.conn.Read(a.ctx)
	if err != nil {
		return nil, err
	}
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, fmt.Errorf("invalid message: %w", err)
	}
	return &msg, nil
}

// ── Consent stdin reader ──────────────────────────────────────────────────
//
// When running as a Tauri sidecar (require_consent=true), the Tauri wrapper
// shows a native dialog and writes the response back on stdin:
//
//	CONSENT_GRANTED:<session_id>
//	CONSENT_DENIED:<session_id>
//
// This goroutine reads these lines and signals the waiting handleDesktopStart.
func (a *Agent) stdinConsentReader() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		var granted bool
		var sessionID string
		switch {
		case strings.HasPrefix(line, "CONSENT_GRANTED:"):
			granted = true
			sessionID = strings.TrimPrefix(line, "CONSENT_GRANTED:")
		case strings.HasPrefix(line, "CONSENT_DENIED:"):
			granted = false
			sessionID = strings.TrimPrefix(line, "CONSENT_DENIED:")
		case strings.HasPrefix(line, "DESKTOP_STOP:"):
			// User clicked "Disconnect" on the session overlay in the
			// Tauri wrapper. Tear down the matching desktop stream.
			sessionID = strings.TrimSpace(strings.TrimPrefix(line, "DESKTOP_STOP:"))
			if sessionID == "" {
				continue
			}
			if sess, loaded := a.desktopStreams.LoadAndDelete(sessionID); loaded {
				sess.(*DesktopStreamer).Stop()
			}
			continue
		default:
			continue
		}
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		if ch, ok := a.consentWaiters.Load(sessionID); ok {
			select {
			case ch.(chan bool) <- granted:
			default:
			}
		}
	}
}
