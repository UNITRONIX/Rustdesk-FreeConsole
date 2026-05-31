package cdap

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Message is the top-level CDAP protocol envelope.
type Message struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`        // command correlation ID
	Timestamp string          `json:"timestamp,omitempty"` // ISO-8601
	Payload   json.RawMessage `json:"payload"`
}

// AuthPayload is sent by client in the "auth" message.
type AuthPayload struct {
	Method        string `json:"method"`              // user_password, api_key, device_token
	Username      string `json:"username,omitempty"`  // for user_password
	Password      string `json:"password,omitempty"`  // for user_password
	TOTPCode      string `json:"totp_code,omitempty"` // optional 2FA code
	Key           string `json:"key,omitempty"`       // for api_key
	Token         string `json:"token,omitempty"`     // for device_token
	DeviceID      string `json:"device_id,omitempty"` // requested device ID
	ClientVersion string `json:"client_version,omitempty"`
}

// AuthResult is sent by server in the "auth_result" message.
type AuthResult struct {
	Success      bool   `json:"success"`
	Token        string `json:"token,omitempty"` // JWT 24h
	Role         string `json:"role,omitempty"`
	DeviceID     string `json:"device_id,omitempty"`
	SessionToken string `json:"session_token,omitempty"`
	Requires2FA  bool   `json:"requires_2fa,omitempty"`
	TFAType      string `json:"tfa_type,omitempty"`
	PartialToken string `json:"partial_token,omitempty"`
	Error        string `json:"error,omitempty"`
}

// RegisterPayload is sent by client in the "register" message.
type RegisterPayload struct {
	Manifest *Manifest `json:"manifest"`
}

// HeartbeatPayload is sent by client in the "heartbeat" message.
type HeartbeatPayload struct {
	Metrics      *MetricsData   `json:"metrics,omitempty"`
	WidgetValues map[string]any `json:"widget_values,omitempty"`
}

// MetricsData holds standard system metrics.
type MetricsData struct {
	CPU    float64 `json:"cpu"`
	Memory float64 `json:"memory"`
	Disk   float64 `json:"disk"`
}

// StateUpdatePayload is sent by client in the "state_update" message.
type StateUpdatePayload struct {
	WidgetID  string `json:"widget_id"`
	Value     any    `json:"value"`
	Timestamp string `json:"timestamp,omitempty"`
}

// BulkUpdatePayload is sent by client in the "bulk_update" message.
type BulkUpdatePayload struct {
	Updates []StateUpdatePayload `json:"updates"`
}

// CommandPayload is sent by server in the "command" message.
type CommandPayload struct {
	CommandID string `json:"command_id"`
	WidgetID  string `json:"widget_id"`
	Action    string `json:"action"` // set, trigger, execute, reset, query
	Value     any    `json:"value,omitempty"`
	Operator  string `json:"operator,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// CommandMessage wraps a command to be sent to a device.
type CommandMessage struct {
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

// CommandResponsePayload is sent by client in response to a command.
type CommandResponsePayload struct {
	CommandID    string `json:"command_id"`
	Status       string `json:"status"` // ok, error, timeout, rejected, queued, unauthorized
	ExecTimeMs   int    `json:"execution_time_ms,omitempty"`
	Result       any    `json:"result,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

// EventPayload is sent by client for custom events.
type EventPayload struct {
	EventType string `json:"event_type"`
	Data      any    `json:"data,omitempty"`
}

// LogPayload is sent by client for log entries.
type LogPayload struct {
	Level   string `json:"level"` // debug, info, warning, error, critical
	Message string `json:"message"`
	Context any    `json:"context,omitempty"`
}

// UnregisterPayload is sent by client to disconnect.
type UnregisterPayload struct {
	Reason string `json:"reason,omitempty"`
}

// HelpRequestPayload is sent by an agent device to raise a support request.
// The device identity is taken from the authenticated connection (dc.ID),
// never from the payload, to prevent spoofing.
type HelpRequestPayload struct {
	Message  string `json:"message"`
	Hostname string `json:"hostname,omitempty"`
}

// ChatMessagePayload is sent by an agent device to deliver a chat message to
// the operator console. The sender identity is taken from the authenticated
// connection (dc.ID).
type ChatMessagePayload struct {
	Text string `json:"text"`
	ToID string `json:"to_id,omitempty"` // optional target operator/group; "" = console
}

// TokenRefreshPayload is sent by client to refresh JWT.
type TokenRefreshPayload struct {
	Token string `json:"token"`
}

// ErrorPayload is sent by server for protocol errors.
type ErrorPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// DeviceConn represents an authenticated CDAP device connection.
type DeviceConn struct {
	ID       string // Device ID (CDAP-XXXXXXXX or custom)
	Username string // Authenticated user
	Role     string // admin, operator, viewer
	ClientIP string

	conn *websocket.Conn
	mu   sync.Mutex // serialise writes

	// Device metadata
	Manifest          *Manifest
	HeartbeatInterval int // seconds (from manifest or default 15)

	// Session
	Token       string
	TokenExpiry time.Time
	SessionID   string

	// Timestamps
	ConnectedAt   time.Time
	LastHeartbeat time.Time

	// Counters
	HeartbeatCount atomic.Int64
	CommandCount   atomic.Int64

	// Widget state cache (widget_id → last value)
	widgetState sync.Map // map[string]any
}

// ReadMessage reads and decodes the next CDAP JSON message from the WebSocket.
func (dc *DeviceConn) ReadMessage(ctx context.Context) (*Message, error) {
	typ, data, err := dc.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, fmt.Errorf("expected text frame, got %v", typ)
	}

	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	return &msg, nil
}

// ReadAny reads the next WebSocket frame, returning either a parsed JSON
// Message (for text frames) or the raw payload bytes (for binary frames).
// Used by the message loop to support binary fast-path frames (e.g. raw
// JPEG bytes for desktop sessions) alongside the regular JSON envelope.
func (dc *DeviceConn) ReadAny(ctx context.Context) (typ websocket.MessageType, raw []byte, msg *Message, err error) {
	typ, data, err := dc.conn.Read(ctx)
	if err != nil {
		return 0, nil, nil, err
	}
	if typ == websocket.MessageBinary {
		return typ, data, nil, nil
	}
	var m Message
	if jErr := json.Unmarshal(data, &m); jErr != nil {
		return typ, nil, nil, fmt.Errorf("invalid JSON: %w", jErr)
	}
	return typ, data, &m, nil
}

// WriteBinary sends a raw binary WebSocket frame on the connection.
// Used for high-throughput media (e.g. desktop JPEG frames) to avoid the
// per-frame base64+JSON overhead. The first bytes of the payload should
// encode any framing the recipient needs (e.g. session ID prefix).
func (dc *DeviceConn) WriteBinary(ctx context.Context, data []byte) error {
	dc.mu.Lock()
	defer dc.mu.Unlock()
	return dc.conn.Write(ctx, websocket.MessageBinary, data)
}

// WriteMessage encodes and sends a CDAP JSON message on the WebSocket.
func (dc *DeviceConn) WriteMessage(ctx context.Context, msg *Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	dc.mu.Lock()
	defer dc.mu.Unlock()
	return dc.conn.Write(ctx, websocket.MessageText, data)
}

// Close closes the underlying WebSocket connection.
func (dc *DeviceConn) Close(code websocket.StatusCode, reason string) {
	dc.conn.Close(code, reason)
}

// sendError sends a protocol error message to the client.
func sendError(ctx context.Context, conn *websocket.Conn, code int, message string) {
	payload, _ := json.Marshal(ErrorPayload{Code: code, Message: message})
	msg := Message{
		Type:      "error",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payload,
	}
	data, _ := json.Marshal(msg)
	conn.Write(ctx, websocket.MessageText, data)
}

// sendMessage is a convenience for sending typed payloads to a connection.
func sendMessage(ctx context.Context, conn *websocket.Conn, msgType string, payload any) error {
	payloadData, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	msg := Message{
		Type:      msgType,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
