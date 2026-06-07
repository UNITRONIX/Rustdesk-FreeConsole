// Package cdap — media_control handles adaptive quality negotiation,
// custom cursor rendering, codec negotiation, and multi-monitor support
// for desktop and video sessions.
package cdap

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/coder/websocket"
)

// ──────────────────────────────────────────────────────────────────────
// Cursor
// ──────────────────────────────────────────────────────────────────────

// CursorUpdatePayload carries custom cursor image and hotspot from device.
type CursorUpdatePayload struct {
	SessionID string `json:"session_id"`
	Format    string `json:"format"`    // png, rgba
	Width     int    `json:"width"`     // cursor image width
	Height    int    `json:"height"`    // cursor image height
	HotspotX  int    `json:"hotspot_x"` // click point offset X
	HotspotY  int    `json:"hotspot_y"` // click point offset Y
	Data      string `json:"data"`      // base64-encoded image data
	CursorID  string `json:"cursor_id"` // stable ID for caching
	Hidden    bool   `json:"hidden"`    // true = hide cursor
}

// HandleCursorUpdate forwards a custom cursor image from device to browser.
func (g *Gateway) HandleCursorUpdate(ctx context.Context, deviceID string, payload json.RawMessage) {
	var cursor CursorUpdatePayload
	if err := json.Unmarshal(payload, &cursor); err != nil {
		log.Printf("[cdap] Invalid cursor payload from %s: %v", deviceID, err)
		return
	}
	if cursor.SessionID == "" {
		return
	}

	val, ok := g.desktopSessions.Load(cursor.SessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.DeviceID != deviceID || ds.closed.Load() {
		return
	}

	fwdMsg, _ := json.Marshal(map[string]any{
		"type":       "cursor_update",
		"session_id": cursor.SessionID,
		"format":     cursor.Format,
		"width":      cursor.Width,
		"height":     cursor.Height,
		"hotspot_x":  cursor.HotspotX,
		"hotspot_y":  cursor.HotspotY,
		"data":       cursor.Data,
		"cursor_id":  cursor.CursorID,
		"hidden":     cursor.Hidden,
	})

	ds.mu.Lock()
	_ = ds.browser.Write(ctx, websocket.MessageText, fwdMsg)
	ds.mu.Unlock()
}

// ──────────────────────────────────────────────────────────────────────
// Adaptive Quality
// ──────────────────────────────────────────────────────────────────────

// QualityReportPayload is sent by the browser with bandwidth/latency stats.
type QualityReportPayload struct {
	SessionID   string  `json:"session_id"`
	BandwidthKB float64 `json:"bandwidth_kb"` // estimated KB/s
	LatencyMS   int     `json:"latency_ms"`   // round-trip ms
	FrameLoss   float64 `json:"frame_loss"`   // 0.0–1.0 fraction of dropped frames
	FPS         int     `json:"fps"`          // actual received FPS
}

// QualityAdjustPayload is sent to the device to change stream parameters.
type QualityAdjustPayload struct {
	SessionID string `json:"session_id"`
	Quality   int    `json:"quality,omitempty"` // JPEG quality 1–100
	FPS       int    `json:"fps,omitempty"`     // target FPS
	Width     int    `json:"width,omitempty"`   // target resolution
	Height    int    `json:"height,omitempty"`
	MaxKBps   int    `json:"max_kbps,omitempty"` // bandwidth cap
}

// HandleQualityReport processes a quality report from the browser and
// computes adaptive quality adjustments for the device.
func (g *Gateway) HandleQualityReport(ctx context.Context, sessionID string, payload json.RawMessage) {
	var report QualityReportPayload
	if err := json.Unmarshal(payload, &report); err != nil {
		return
	}

	// Determine session type (desktop or video)
	var deviceConn *DeviceConn
	if val, ok := g.desktopSessions.Load(sessionID); ok {
		ds := val.(*DesktopSession)
		deviceConn = ds.deviceConn
	} else if val, ok := g.videoSessions.Load(sessionID); ok {
		vs := val.(*VideoSession)
		deviceConn = vs.deviceConn
	}
	if deviceConn == nil {
		return
	}

	// Compute adaptive quality based on network conditions
	adjust := computeQualityAdjustment(&report)
	if adjust == nil {
		return // no adjustment needed
	}
	adjust.SessionID = sessionID

	adjustData, _ := json.Marshal(adjust)
	msg := &Message{
		Type:      "quality_adjust",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   adjustData,
	}
	deviceConn.WriteMessage(ctx, msg)
}

// computeQualityAdjustment returns a QualityAdjustPayload if conditions
// warrant changing stream parameters, or nil if current settings are fine.
func computeQualityAdjustment(report *QualityReportPayload) *QualityAdjustPayload {
	var adjust QualityAdjustPayload
	changed := false

	// High latency → lower quality and FPS
	if report.LatencyMS > 200 {
		adjust.Quality = 40
		adjust.FPS = 10
		changed = true
	} else if report.LatencyMS > 100 {
		adjust.Quality = 60
		adjust.FPS = 15
		changed = true
	}

	// High frame loss → lower FPS
	if report.FrameLoss > 0.2 {
		adjust.FPS = 5
		changed = true
	} else if report.FrameLoss > 0.1 {
		if adjust.FPS == 0 || adjust.FPS > 10 {
			adjust.FPS = 10
		}
		changed = true
	}

	// Low bandwidth → lower quality
	if report.BandwidthKB > 0 && report.BandwidthKB < 100 {
		adjust.Quality = 30
		adjust.MaxKBps = int(report.BandwidthKB * 0.8)
		changed = true
	} else if report.BandwidthKB > 0 && report.BandwidthKB < 500 {
		if adjust.Quality == 0 || adjust.Quality > 50 {
			adjust.Quality = 50
		}
		changed = true
	}

	if !changed {
		return nil
	}
	return &adjust
}

// ──────────────────────────────────────────────────────────────────────
// Codec Negotiation
// ──────────────────────────────────────────────────────────────────────

// CodecOfferPayload is sent by the browser declaring supported codecs.
type CodecOfferPayload struct {
	SessionID string   `json:"session_id"`
	Video     []string `json:"video"`     // e.g. ["jpeg","png","h264","vp8"]
	Audio     []string `json:"audio"`     // e.g. ["opus","pcm"]
	Preferred string   `json:"preferred"` // preferred video codec
}

// CodecAnswerPayload is the device's chosen codec from the offer list.
type CodecAnswerPayload struct {
	SessionID  string `json:"session_id"`
	VideoCodec string `json:"video_codec"` // chosen video codec
	AudioCodec string `json:"audio_codec"` // chosen audio codec
}

// RelayCodecOffer forwards a codec offer from browser to device.
func (g *Gateway) RelayCodecOffer(ctx context.Context, sessionID string, payload json.RawMessage) error {
	var deviceConn *DeviceConn
	if val, ok := g.desktopSessions.Load(sessionID); ok {
		deviceConn = val.(*DesktopSession).deviceConn
	} else if val, ok := g.videoSessions.Load(sessionID); ok {
		deviceConn = val.(*VideoSession).deviceConn
	}
	if deviceConn == nil {
		return nil
	}

	msg := &Message{
		Type:      "codec_offer",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payload,
	}
	return deviceConn.WriteMessage(ctx, msg)
}

// HandleCodecAnswer forwards the device's codec choice to the browser.
func (g *Gateway) HandleCodecAnswer(ctx context.Context, deviceID string, payload json.RawMessage) {
	var answer CodecAnswerPayload
	if err := json.Unmarshal(payload, &answer); err != nil {
		return
	}
	if answer.SessionID == "" {
		return
	}

	// Forward to the correct session's browser WS
	if val, ok := g.desktopSessions.Load(answer.SessionID); ok {
		ds := val.(*DesktopSession)
		if ds.DeviceID == deviceID {
			fwdMsg, _ := json.Marshal(map[string]any{
				"type":        "codec_answer",
				"session_id":  answer.SessionID,
				"video_codec": answer.VideoCodec,
				"audio_codec": answer.AudioCodec,
			})
			ds.mu.Lock()
			_ = ds.browser.Write(ctx, websocket.MessageText, fwdMsg)
			ds.mu.Unlock()
		}
	} else if val, ok := g.videoSessions.Load(answer.SessionID); ok {
		vs := val.(*VideoSession)
		if vs.DeviceID == deviceID {
			fwdMsg, _ := json.Marshal(map[string]any{
				"type":        "codec_answer",
				"session_id":  answer.SessionID,
				"video_codec": answer.VideoCodec,
				"audio_codec": answer.AudioCodec,
			})
			vs.mu.Lock()
			_ = vs.browser.Write(ctx, websocket.MessageText, fwdMsg)
			vs.mu.Unlock()
		}
	}
}

// ──────────────────────────────────────────────────────────────────────
// Multi-Monitor
// ──────────────────────────────────────────────────────────────────────

// MonitorInfo describes a single display attached to the device.
type MonitorInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	X       int    `json:"x"` // desktop position
	Y       int    `json:"y"`
	Primary bool   `json:"primary"`
	ScaleF  int    `json:"scale_factor,omitempty"` // DPI scale percentage (100=1x)
}

// MonitorListPayload is sent by the device listing available displays.
type MonitorListPayload struct {
	SessionID string        `json:"session_id"`
	Monitors  []MonitorInfo `json:"monitors"`
	Active    int           `json:"active"` // currently streaming index
}

// MonitorSelectPayload is sent by the browser to switch displays.
type MonitorSelectPayload struct {
	SessionID string `json:"session_id"`
	Index     int    `json:"index"` // monitor index to stream
}

// DesktopMetaPayload is emitted by the device when a stream starts or the
// encoding format / frame dimensions change.
type DesktopMetaPayload struct {
	SessionID   string `json:"session_id"`
	Format      string `json:"format"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Binary      bool   `json:"binary"`
	CodecString string `json:"codec_string"`
}

// HandleDesktopMeta forwards stream format metadata to the operator browser.
// Without this, RDClient cannot choose the JPEG vs H.264 decode path and
// shows a black canvas even when binary frames arrive.
func (g *Gateway) HandleDesktopMeta(ctx context.Context, deviceID string, payload json.RawMessage) {
	var meta DesktopMetaPayload
	if err := json.Unmarshal(payload, &meta); err != nil {
		return
	}
	if meta.SessionID == "" {
		return
	}

	val, ok := g.desktopSessions.Load(meta.SessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.DeviceID != deviceID || ds.closed.Load() {
		return
	}

	fwd := map[string]any{
		"type":       "desktop_meta",
		"session_id": meta.SessionID,
		"format":     meta.Format,
		"width":      meta.Width,
		"height":     meta.Height,
		"binary":     meta.Binary,
	}
	if meta.CodecString != "" {
		fwd["codec_string"] = meta.CodecString
	}
	fwdMsg, _ := json.Marshal(fwd)

	ds.mu.Lock()
	_ = ds.browser.Write(ctx, websocket.MessageText, fwdMsg)
	ds.mu.Unlock()
}

// HandleMonitorList forwards the device's monitor list to the browser.
func (g *Gateway) HandleMonitorList(ctx context.Context, deviceID string, payload json.RawMessage) {
	var ml MonitorListPayload
	if err := json.Unmarshal(payload, &ml); err != nil {
		return
	}
	if ml.SessionID == "" {
		return
	}

	val, ok := g.desktopSessions.Load(ml.SessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.DeviceID != deviceID || ds.closed.Load() {
		return
	}

	fwdMsg, _ := json.Marshal(map[string]any{
		"type":       "monitor_list",
		"session_id": ml.SessionID,
		"monitors":   ml.Monitors,
		"active":     ml.Active,
	})

	ds.mu.Lock()
	_ = ds.browser.Write(ctx, websocket.MessageText, fwdMsg)
	ds.mu.Unlock()
}

// RelayMonitorSelect forwards the browser's monitor selection to the device.
func (g *Gateway) RelayMonitorSelect(ctx context.Context, sessionID string, index int) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return nil
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return nil
	}

	payload := MonitorSelectPayload{
		SessionID: sessionID,
		Index:     index,
	}
	data, _ := json.Marshal(payload)
	msg := &Message{
		Type:      "monitor_select",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}
	return ds.deviceConn.WriteMessage(ctx, msg)
}

// ──────────────────────────────────────────────────────────────────────
// Key Exchange Relay (E2E Crypto)
// ──────────────────────────────────────────────────────────────────────

// HandleKeyExchange relays an E2E key exchange message from the device
// to the browser (or vice versa). The server is transparent — it cannot
// read the exchanged keys or decrypt media frames.
func (g *Gateway) HandleKeyExchange(ctx context.Context, deviceID string, payload json.RawMessage) {
	var kx KeyExchangePayload
	if err := json.Unmarshal(payload, &kx); err != nil {
		log.Printf("[cdap] Invalid key_exchange from %s: %v", deviceID, err)
		return
	}
	if kx.SessionID == "" {
		return
	}

	// Forward to the correct session's browser WS
	if val, ok := g.desktopSessions.Load(kx.SessionID); ok {
		ds := val.(*DesktopSession)
		if ds.DeviceID == deviceID {
			ds.mu.Lock()
			_ = ds.browser.Write(ctx, websocket.MessageText, payload)
			ds.mu.Unlock()
		}
	} else if val, ok := g.videoSessions.Load(kx.SessionID); ok {
		vs := val.(*VideoSession)
		if vs.DeviceID == deviceID {
			vs.mu.Lock()
			_ = vs.browser.Write(ctx, websocket.MessageText, payload)
			vs.mu.Unlock()
		}
	} else if val, ok := g.audioSessions.Load(kx.SessionID); ok {
		as := val.(*AudioSession)
		if as.DeviceID == deviceID {
			as.mu.Lock()
			_ = as.browser.Write(ctx, websocket.MessageText, payload)
			as.mu.Unlock()
		}
	}
}

// RelayKeyExchangeToBrowser forwards a key_exchange from browser→device.
func (g *Gateway) RelayKeyExchangeToDevice(ctx context.Context, sessionID string, payload json.RawMessage) error {
	var deviceConn *DeviceConn
	if val, ok := g.desktopSessions.Load(sessionID); ok {
		deviceConn = val.(*DesktopSession).deviceConn
	} else if val, ok := g.videoSessions.Load(sessionID); ok {
		deviceConn = val.(*VideoSession).deviceConn
	} else if val, ok := g.audioSessions.Load(sessionID); ok {
		deviceConn = val.(*AudioSession).deviceConn
	}
	if deviceConn == nil {
		return nil
	}

	msg := &Message{
		Type:      "key_exchange",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payload,
	}
	return deviceConn.WriteMessage(ctx, msg)
}

// RelayKeyframeRequest forwards a keyframe request from browser to device.
func (g *Gateway) RelayKeyframeRequest(ctx context.Context, sessionID string) error {
	var deviceConn *DeviceConn
	if val, ok := g.desktopSessions.Load(sessionID); ok {
		deviceConn = val.(*DesktopSession).deviceConn
	} else if val, ok := g.videoSessions.Load(sessionID); ok {
		deviceConn = val.(*VideoSession).deviceConn
	}
	if deviceConn == nil {
		return nil
	}

	payload, _ := json.Marshal(map[string]string{
		"session_id": sessionID,
	})
	msg := &Message{
		Type:      "keyframe_request",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payload,
	}
	return deviceConn.WriteMessage(ctx, msg)
}
