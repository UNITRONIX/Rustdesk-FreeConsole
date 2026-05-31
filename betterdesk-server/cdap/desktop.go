// Package cdap — desktop handles the binary/text WebSocket channel for
// remote desktop sessions between the admin panel and CDAP devices.
// Supports both frame-based (MJPEG/raw) and input relay (mouse/keyboard).
package cdap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// DesktopSession represents an active remote desktop session relaying
// video frames from device→browser and input events from browser→device.
type DesktopSession struct {
	ID       string
	DeviceID string
	Username string
	Role     string

	browser    *websocket.Conn
	deviceConn *DeviceConn

	createdAt time.Time
	mu        sync.Mutex
	closed    atomic.Bool
}

// DesktopStartPayload is sent to the device to initiate a desktop session.
type DesktopStartPayload struct {
	SessionID  string   `json:"session_id"`
	Width      int      `json:"width"`
	Height     int      `json:"height"`
	Quality    int      `json:"quality"` // JPEG quality 1-100
	FPS        int      `json:"fps"`     // target frames per second
	Codecs     []string `json:"codecs,omitempty"`      // codecs the operator can decode
	VideoCodec string   `json:"video_codec,omitempty"` // operator codec preference ("auto" = let agent choose)
}

// DesktopFramePayload is sent from the device to the browser.
type DesktopFramePayload struct {
	SessionID string `json:"session_id"`
	Format    string `json:"format"`    // jpeg, png, raw
	Width     int    `json:"width"`     // frame width
	Height    int    `json:"height"`    // frame height
	Data      string `json:"data"`      // base64-encoded frame data
	Timestamp int64  `json:"timestamp"` // capture timestamp ms
}

// DesktopInputPayload is sent from the browser to the device.
// It matches the Go agent's InputEvent schema so the server can translate
// browser-side mouse/keyboard events into an executable device payload.
type DesktopInputPayload struct {
	SessionID string   `json:"session_id"`
	Type      string   `json:"type"`
	X         int      `json:"x,omitempty"`
	Y         int      `json:"y,omitempty"`
	Button    int      `json:"button,omitempty"`
	Key       string   `json:"key,omitempty"`
	Code      string   `json:"code,omitempty"`
	Text      string   `json:"text,omitempty"`
	Modifiers []string `json:"modifiers,omitempty"`
	DeltaX    int      `json:"delta_x,omitempty"`
	DeltaY    int      `json:"delta_y,omitempty"`
	Pressed   bool     `json:"pressed,omitempty"`
}

// DesktopResizePayload is sent when the browser viewport resizes.
type DesktopResizePayload struct {
	SessionID string `json:"session_id"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

// DesktopEndPayload is sent when a desktop session ends.
type DesktopEndPayload struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason,omitempty"`
}

// StartDesktopSession creates a new remote desktop session between the
// browser and a CDAP device for screen capture and input relay.
func (g *Gateway) StartDesktopSession(ctx context.Context, browserConn *websocket.Conn, deviceID, username, role string, width, height, quality, fps int, codecs []string, videoCodec string) (*DesktopSession, error) {
	dc := g.GetDeviceConn(deviceID)
	if dc == nil {
		return nil, fmt.Errorf("device %s not connected", deviceID)
	}

	// Check that device supports remote_desktop capability
	if dc.Manifest != nil {
		hasDesktop := false
		for _, cap := range dc.Manifest.Capabilities {
			if cap == "remote_desktop" {
				hasDesktop = true
				break
			}
		}
		if !hasDesktop {
			return nil, fmt.Errorf("device %s does not support remote_desktop", deviceID)
		}
	}

	if quality <= 0 || quality > 100 {
		quality = 70
	}
	if fps <= 0 || fps > 60 {
		fps = 15
	}
	if width <= 0 {
		width = 1280
	}
	if height <= 0 {
		height = 720
	}

	sessionID := fmt.Sprintf("desk_%s_%d", deviceID, time.Now().UnixNano())

	ds := &DesktopSession{
		ID:         sessionID,
		DeviceID:   deviceID,
		Username:   username,
		Role:       role,
		browser:    browserConn,
		deviceConn: dc,
		createdAt:  time.Now(),
	}

	startPayload := DesktopStartPayload{
		SessionID:  sessionID,
		Width:      width,
		Height:     height,
		Quality:    quality,
		FPS:        fps,
		Codecs:     codecs,
		VideoCodec: videoCodec,
	}
	data, _ := json.Marshal(startPayload)
	msg := &Message{
		Type:      "desktop_start",
		ID:        sessionID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}

	if err := dc.WriteMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("send desktop_start to device: %w", err)
	}

	g.desktopSessions.Store(sessionID, ds)

	log.Printf("[cdap] Desktop session %s started for device %s by %s (%dx%d q%d @%dfps)",
		sessionID, deviceID, username, width, height, quality, fps)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_desktop_started", dc.ClientIP, username, map[string]string{
			"session_id": sessionID,
			"device_id":  deviceID,
		})
	}

	return ds, nil
}

// RelayDesktopInput forwards mouse/keyboard input from browser to device.
func (g *Gateway) RelayDesktopInput(ctx context.Context, sessionID string, input *DesktopInputPayload) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return fmt.Errorf("desktop session %s is closed", sessionID)
	}

	input.SessionID = sessionID
	payloadData, _ := json.Marshal(input)
	msg := &Message{
		Type:      "desktop_input",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ds.deviceConn.WriteMessage(ctx, msg)
}

// RelayDesktopResize forwards a viewport resize from browser to device.
func (g *Gateway) RelayDesktopResize(ctx context.Context, sessionID string, width, height int) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)

	payload := DesktopResizePayload{
		SessionID: sessionID,
		Width:     width,
		Height:    height,
	}
	payloadData, _ := json.Marshal(payload)
	msg := &Message{
		Type:      "desktop_resize",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ds.deviceConn.WriteMessage(ctx, msg)
}

// HandleDesktopFrame is called when the device sends a captured frame.
// It forwards the frame to the browser WebSocket.
func (g *Gateway) HandleDesktopFrame(ctx context.Context, sessionID string, frame *DesktopFramePayload) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return nil
	}

	output := map[string]any{
		"type":       "frame",
		"session_id": sessionID,
		"format":     frame.Format,
		"width":      frame.Width,
		"height":     frame.Height,
		"data":       frame.Data,
		"timestamp":  frame.Timestamp,
	}
	outData, _ := json.Marshal(output)

	ds.mu.Lock()
	defer ds.mu.Unlock()
	return ds.browser.Write(ctx, websocket.MessageText, outData)
}

// frameHeaderSize is the fixed-size session-ID prefix on every binary
// desktop frame from the agent. The agent zero-pads sessionID to this
// length; the server uses it to route the frame to the correct browser
// without parsing JSON.
const frameHeaderSize = 64

// HandleDesktopFrameBinary is the binary fast-path for desktop frames.
// The payload format is: [frameHeaderSize bytes session ID, NUL-padded][raw JPEG bytes].
// The raw JPEG is forwarded to the browser as a single binary WS frame —
// no base64, no JSON. This is the difference between 1–3 fps and 30+ fps.
func (g *Gateway) handleDesktopFrameBinary(ctx context.Context, _ *DeviceConn, data []byte) {
	if len(data) < frameHeaderSize {
		return
	}
	// Extract zero-padded session ID.
	hdr := data[:frameHeaderSize]
	end := bytes.IndexByte(hdr, 0)
	if end < 0 {
		end = frameHeaderSize
	}
	sessionID := string(hdr[:end])
	if sessionID == "" {
		return
	}

	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return
	}

	frame := data[frameHeaderSize:]
	if len(frame) == 0 {
		return
	}

	ds.mu.Lock()
	err := ds.browser.Write(ctx, websocket.MessageBinary, frame)
	ds.mu.Unlock()
	if err != nil && ctx.Err() == nil {
		log.Printf("[cdap] desktop binary frame write failed for session %s: %v", sessionID, err)
	}
}

// EndDesktopSession terminates a desktop session.
func (g *Gateway) EndDesktopSession(ctx context.Context, sessionID, reason string) {
	val, ok := g.desktopSessions.LoadAndDelete(sessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.closed.Swap(true) {
		return
	}

	endPayload := DesktopEndPayload{
		SessionID: sessionID,
		Reason:    reason,
	}
	data, _ := json.Marshal(endPayload)
	msg := &Message{
		Type:      "desktop_stop",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}
	_ = ds.deviceConn.WriteMessage(ctx, msg)

	endMsg, _ := json.Marshal(map[string]string{
		"type":       "end",
		"session_id": sessionID,
		"reason":     reason,
	})
	ds.mu.Lock()
	ds.browser.Write(ctx, websocket.MessageText, endMsg)
	ds.mu.Unlock()
	ds.browser.Close(websocket.StatusNormalClosure, reason)

	log.Printf("[cdap] Desktop session %s ended: %s", sessionID, reason)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_desktop_ended", ds.deviceConn.ClientIP, ds.Username, map[string]string{
			"session_id": sessionID,
			"device_id":  ds.DeviceID,
			"reason":     reason,
		})
	}
}

// HandleDesktopInputError forwards input injection failures from the device to
// the browser session so operators get an actionable error instead of silent no-op input.
func (g *Gateway) HandleDesktopInputError(ctx context.Context, _ *DeviceConn, msg *Message) {
	var payload struct {
		SessionID string `json:"session_id"`
		Type      string `json:"type"`
		Message   string `json:"message"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.SessionID == "" {
		return
	}

	val, ok := g.desktopSessions.Load(payload.SessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return
	}

	text := payload.Message
	if text == "" {
		text = "remote input injection failed"
	}
	out, _ := json.Marshal(map[string]string{
		"type":       "error",
		"session_id": payload.SessionID,
		"error":      text,
	})
	ds.mu.Lock()
	_ = ds.browser.Write(ctx, websocket.MessageText, out)
	ds.mu.Unlock()
}

func (g *Gateway) cleanupDeviceSessions(deviceID, reason string) {
	g.desktopSessions.Range(func(key, value any) bool {
		ds, ok := value.(*DesktopSession)
		if !ok || ds.DeviceID != deviceID {
			return true
		}
		g.EndDesktopSession(context.Background(), ds.ID, reason)
		g.desktopSessions.Delete(key)
		return true
	})
}
