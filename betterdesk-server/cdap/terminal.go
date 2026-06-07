// Package cdap — terminal handles the binary WebSocket channel for
// interactive terminal sessions between the admin panel and CDAP devices.
package cdap

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// TerminalSession represents an active terminal session relaying between
// a browser client and a CDAP device.
type TerminalSession struct {
	ID       string
	DeviceID string
	Username string
	Role     string

	// browser is the WebSocket connection from the admin panel.
	browser *websocket.Conn
	// device points to the DeviceConn's underlying connection.
	deviceConn *DeviceConn

	createdAt time.Time
	mu        sync.Mutex
	closed    atomic.Bool
}

// TerminalInputPayload is sent from the browser to the device.
type TerminalInputPayload struct {
	SessionID string `json:"session_id"`
	Data      string `json:"data"` // base64 or raw text
}

// TerminalOutputPayload is sent from the device to the browser.
type TerminalOutputPayload struct {
	SessionID string `json:"session_id"`
	Data      string `json:"data"`
	Stream    string `json:"stream"` // stdout, stderr
}

// TerminalResizePayload is sent when the browser terminal resizes.
type TerminalResizePayload struct {
	SessionID string `json:"session_id"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

// TerminalStartRequest is sent to the device to open a terminal session.
type TerminalStartPayload struct {
	SessionID    string `json:"session_id"`
	Shell        string `json:"shell,omitempty"` // optional shell path
	Cols         int    `json:"cols"`
	Rows         int    `json:"rows"`
	OperatorName string `json:"operator_name,omitempty"`
}

// TerminalEndPayload is sent when a terminal session ends.
type TerminalEndPayload struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason,omitempty"`
}

// StartTerminalSession creates a new terminal session between the browser
// client and the CDAP device. The session relays I/O bidirectionally.
func (g *Gateway) StartTerminalSession(ctx context.Context, browserConn *websocket.Conn, deviceID, username, role string, cols, rows int) (*TerminalSession, error) {
	dc := g.GetDeviceConn(deviceID)
	if dc == nil {
		return nil, fmt.Errorf("device %s not connected", deviceID)
	}

	// Check that device supports terminal capability
	if dc.Manifest != nil {
		hasTerminal := false
		for _, cap := range dc.Manifest.Capabilities {
			if cap == "commands" {
				hasTerminal = true
				break
			}
		}
		if !hasTerminal {
			return nil, fmt.Errorf("device %s does not support terminal", deviceID)
		}
	}

	sessionID := fmt.Sprintf("term_%s_%d", deviceID, time.Now().UnixNano())

	ts := &TerminalSession{
		ID:         sessionID,
		DeviceID:   deviceID,
		Username:   username,
		Role:       role,
		browser:    browserConn,
		deviceConn: dc,
		createdAt:  time.Now(),
	}

	// Send terminal_start command to the device
	startPayload := TerminalStartPayload{
		SessionID:    sessionID,
		Cols:         cols,
		Rows:         rows,
		OperatorName: username,
	}
	data, _ := json.Marshal(startPayload)
	msg := &Message{
		Type:      "terminal_start",
		ID:        sessionID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}

	if err := dc.WriteMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("send terminal_start to device: %w", err)
	}

	// Store terminal session in gateway
	g.terminalSessions.Store(sessionID, ts)

	log.Printf("[cdap] Terminal session %s started for device %s by %s", sessionID, deviceID, username)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_terminal_started", dc.ClientIP, username, map[string]string{
			"session_id": sessionID,
			"device_id":  deviceID,
		})
	}

	return ts, nil
}

// RelayTerminalInput forwards a terminal_input message from browser to device.
func (g *Gateway) RelayTerminalInput(ctx context.Context, sessionID, data string) error {
	val, ok := g.terminalSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("terminal session %s not found", sessionID)
	}
	ts := val.(*TerminalSession)
	if ts.closed.Load() {
		return fmt.Errorf("terminal session %s is closed", sessionID)
	}

	payload := TerminalInputPayload{
		SessionID: sessionID,
		Data:      data,
	}
	payloadData, _ := json.Marshal(payload)
	msg := &Message{
		Type:      "terminal_input",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ts.deviceConn.WriteMessage(ctx, msg)
}

// RelayTerminalResize forwards a terminal_resize message from browser to device.
func (g *Gateway) RelayTerminalResize(ctx context.Context, sessionID string, cols, rows int) error {
	val, ok := g.terminalSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("terminal session %s not found", sessionID)
	}
	ts := val.(*TerminalSession)

	payload := TerminalResizePayload{
		SessionID: sessionID,
		Cols:      cols,
		Rows:      rows,
	}
	payloadData, _ := json.Marshal(payload)
	msg := &Message{
		Type:      "terminal_resize",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ts.deviceConn.WriteMessage(ctx, msg)
}

// HandleTerminalOutput is called when the device sends terminal output
// back to the gateway. It forwards the data to the browser WebSocket.
func (g *Gateway) HandleTerminalOutput(ctx context.Context, sessionID, data, stream string) error {
	val, ok := g.terminalSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("terminal session %s not found", sessionID)
	}
	ts := val.(*TerminalSession)
	if ts.closed.Load() {
		return nil
	}

	// Forward to browser as JSON (browser WebSocket expects text frames)
	output := map[string]string{
		"type":       "output",
		"session_id": sessionID,
		"data":       data,
		"stream":     stream,
	}
	outData, _ := json.Marshal(output)

	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.browser.Write(ctx, websocket.MessageText, outData)
}

// EndTerminalSession terminates a terminal session.
func (g *Gateway) EndTerminalSession(ctx context.Context, sessionID, reason string) {
	val, ok := g.terminalSessions.LoadAndDelete(sessionID)
	if !ok {
		return
	}
	ts := val.(*TerminalSession)
	if ts.closed.Swap(true) {
		return // already closed
	}

	// Send terminal_end to device
	endPayload := TerminalEndPayload{
		SessionID: sessionID,
		Reason:    reason,
	}
	data, _ := json.Marshal(endPayload)
	msg := &Message{
		Type:      "terminal_end",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}
	ts.deviceConn.WriteMessage(ctx, msg)

	// Notify browser that session ended
	endMsg, _ := json.Marshal(map[string]string{
		"type":       "end",
		"session_id": sessionID,
		"reason":     reason,
	})
	ts.mu.Lock()
	ts.browser.Write(ctx, websocket.MessageText, endMsg)
	ts.mu.Unlock()
	ts.browser.Close(websocket.StatusNormalClosure, reason)

	log.Printf("[cdap] Terminal session %s ended: %s", sessionID, reason)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_terminal_ended", ts.deviceConn.ClientIP, ts.Username, map[string]string{
			"session_id": sessionID,
			"device_id":  ts.DeviceID,
			"reason":     reason,
		})
	}
}

// GetTerminalSession returns a terminal session by its ID.
func (g *Gateway) GetTerminalSession(sessionID string) *TerminalSession {
	val, ok := g.terminalSessions.Load(sessionID)
	if !ok {
		return nil
	}
	return val.(*TerminalSession)
}
