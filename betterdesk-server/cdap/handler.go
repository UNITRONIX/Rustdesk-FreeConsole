package cdap

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

// handleRegister processes the "register" message after authentication.
// It parses the manifest, creates/updates the peer in the database, and
// registers the device connection in the gateway's in-memory map.
func (g *Gateway) handleRegister(ctx context.Context, dc *DeviceConn) error {
	msg, err := dc.ReadMessage(ctx)
	if err != nil {
		return fmt.Errorf("read register message: %w", err)
	}
	if msg.Type != "register" {
		return fmt.Errorf("expected 'register' message, got '%s'", msg.Type)
	}

	var rp RegisterPayload
	if err := json.Unmarshal(msg.Payload, &rp); err != nil {
		return fmt.Errorf("invalid register payload: %w", err)
	}
	if rp.Manifest == nil {
		return fmt.Errorf("manifest is required")
	}

	// Validate manifest
	if err := ValidateManifest(rp.Manifest); err != nil {
		return fmt.Errorf("invalid manifest: %w", err)
	}

	dc.Manifest = rp.Manifest
	dc.HeartbeatInterval = rp.Manifest.HeartbeatInterval

	// Validate device ID format (CDAP-XXXXXXXX or 6-16 alphanumeric)
	if dc.ID == "" {
		return fmt.Errorf("device_id is required (set in auth payload)")
	}

	// Check if device is banned
	banned, _ := g.db.IsPeerBanned(dc.ID)
	if banned {
		return fmt.Errorf("device is banned")
	}

	// Upsert the peer in the database
	tags := strings.Join(rp.Manifest.Device.Tags, ",")
	peer := &db.Peer{
		ID:           dc.ID,
		Hostname:     rp.Manifest.Device.Name,
		Status:       "ONLINE",
		IP:           dc.ClientIP,
		DeviceType:   rp.Manifest.Device.Type,
		LinkedPeerID: rp.Manifest.Device.LinkedPeerID,
		Tags:         tags,
		User:         dc.Username,
		LastOnline:   time.Now(),
		OS:           rp.Manifest.Bridge.Protocol,
		Version:      rp.Manifest.Bridge.Version,
	}
	if err := g.db.UpsertPeer(peer); err != nil {
		return fmt.Errorf("save peer: %w", err)
	}

	// Store manifest JSON in config (device-specific key)
	manifestJSON, _ := json.Marshal(rp.Manifest)
	g.db.SetConfig(fmt.Sprintf("cdap_manifest_%s", dc.ID), string(manifestJSON))

	// Check for existing connection with same ID (force disconnect old)
	if old, loaded := g.devices.LoadAndDelete(dc.ID); loaded {
		if oldDC, ok := old.(*DeviceConn); ok {
			log.Printf("[cdap] %s: replacing existing connection from %s", dc.ID, oldDC.ClientIP)
			oldDC.Close(4001, "replaced by new connection")
		}
	}

	// Register in gateway's device map
	g.devices.Store(dc.ID, dc)

	// Update peer status to ONLINE
	g.db.UpdatePeerStatus(dc.ID, "ONLINE", dc.ClientIP)
	if err := g.db.TouchDeviceOnlineSession(dc.ID, time.Now().UTC(), time.Duration(dc.HeartbeatInterval*3)*time.Second); err != nil {
		log.Printf("[cdap] failed to record online session for %s: %v", dc.ID, err)
	}

	// Send registration confirmation
	result := map[string]any{
		"device_id":   dc.ID,
		"server_time": time.Now().UTC().Format(time.RFC3339),
	}
	if err := sendMessage(ctx, dc.conn, "registered", result); err != nil {
		return fmt.Errorf("send registered: %w", err)
	}

	// Publish connect event
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "cdap_connect",
			Data: map[string]string{
				"peer_id":     dc.ID,
				"device_type": rp.Manifest.Device.Type,
				"device_name": rp.Manifest.Device.Name,
				"username":    dc.Username,
			},
		})
	}

	g.auditAction("cdap_register", dc.ID, map[string]string{
		"device_name": rp.Manifest.Device.Name,
		"device_type": rp.Manifest.Device.Type,
		"widgets":     fmt.Sprintf("%d", len(rp.Manifest.Widgets)),
		"ip":          dc.ClientIP,
	})

	log.Printf("[cdap] %s: registered (type=%s, name=%s, widgets=%d, heartbeat=%ds)",
		dc.ID, rp.Manifest.Device.Type, rp.Manifest.Device.Name,
		len(rp.Manifest.Widgets), rp.Manifest.HeartbeatInterval)

	return nil
}

// handleHeartbeat processes periodic heartbeat messages.
func (g *Gateway) handleHeartbeat(ctx context.Context, dc *DeviceConn, msg *Message) {
	dc.LastHeartbeat = time.Now()
	dc.HeartbeatCount.Add(1)

	var payload HeartbeatPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3001, "invalid heartbeat payload")
		return
	}

	// Save system metrics if provided
	if payload.Metrics != nil {
		m := payload.Metrics
		if m.CPU > 0 || m.Memory > 0 || m.Disk > 0 {
			g.db.SavePeerMetric(dc.ID, m.CPU, m.Memory, m.Disk)
		}
	}

	// Update widget values
	if payload.WidgetValues != nil {
		for widgetID, value := range payload.WidgetValues {
			dc.widgetState.Store(widgetID, value)
		}

		// Evaluate alert conditions
		if g.alertEngine != nil && dc.Manifest != nil {
			g.alertEngine.Evaluate(dc.ID, dc.Manifest, collectWidgetState(dc))
		}

		// Publish widget state update event
		if g.eventBus != nil {
			valuesJSON, _ := json.Marshal(payload.WidgetValues)
			g.eventBus.Publish(events.Event{
				Type: "cdap_widget_update",
				Data: map[string]string{
					"peer_id": dc.ID,
					"values":  string(valuesJSON),
				},
			})
		}
	}

	// Keep peer ONLINE
	g.db.UpdatePeerStatus(dc.ID, "ONLINE", dc.ClientIP)
	if err := g.db.TouchDeviceOnlineSession(dc.ID, dc.LastHeartbeat.UTC(), time.Duration(dc.HeartbeatInterval*3)*time.Second); err != nil {
		log.Printf("[cdap] failed to record online heartbeat for %s: %v", dc.ID, err)
	}

	// Respond with server ping
	sendMessage(ctx, dc.conn, "ping", map[string]any{
		"server_time": time.Now().UTC().Format(time.RFC3339),
	})
}

// handleStateUpdate processes a single widget state update.
func (g *Gateway) handleStateUpdate(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload StateUpdatePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3002, "invalid state_update payload")
		return
	}

	if payload.WidgetID == "" {
		sendError(ctx, dc.conn, 3003, "widget_id is required")
		return
	}

	// Update cached state
	dc.widgetState.Store(payload.WidgetID, payload.Value)

	// Evaluate alert conditions
	if g.alertEngine != nil && dc.Manifest != nil {
		g.alertEngine.Evaluate(dc.ID, dc.Manifest, collectWidgetState(dc))
	}

	// Publish to event bus for real-time panel updates
	if g.eventBus != nil {
		valueJSON, _ := json.Marshal(payload.Value)
		g.eventBus.Publish(events.Event{
			Type: "cdap_state_update",
			Data: map[string]string{
				"peer_id":   dc.ID,
				"widget_id": payload.WidgetID,
				"value":     string(valueJSON),
			},
		})
	}
}

// handleBulkUpdate processes multiple widget state updates at once.
func (g *Gateway) handleBulkUpdate(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload BulkUpdatePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3004, "invalid bulk_update payload")
		return
	}

	updates := make(map[string]any, len(payload.Updates))
	for _, u := range payload.Updates {
		if u.WidgetID != "" {
			dc.widgetState.Store(u.WidgetID, u.Value)
			updates[u.WidgetID] = u.Value
		}
	}

	// Evaluate alert conditions after all updates are applied
	if g.alertEngine != nil && dc.Manifest != nil && len(updates) > 0 {
		g.alertEngine.Evaluate(dc.ID, dc.Manifest, collectWidgetState(dc))
	}

	if g.eventBus != nil && len(updates) > 0 {
		valuesJSON, _ := json.Marshal(updates)
		g.eventBus.Publish(events.Event{
			Type: "cdap_widget_update",
			Data: map[string]string{
				"peer_id": dc.ID,
				"values":  string(valuesJSON),
			},
		})
	}
}

// handleCommandResponse processes a device's response to a command.
func (g *Gateway) handleCommandResponse(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload CommandResponsePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3005, "invalid command_response payload")
		return
	}

	// Resolve pending command tracking
	if pc, ok := g.ResolvePendingCommand(payload.CommandID); ok {
		latency := time.Since(pc.SentAt)
		if pc.ResultCh != nil {
			select {
			case pc.ResultCh <- &payload:
			default:
			}
		}
		log.Printf("[cdap] %s: command %s → %s (latency: %s)",
			dc.ID, payload.CommandID, payload.Status, latency.Round(time.Millisecond))
	}

	// Publish to event bus so the panel can display the result
	if g.eventBus != nil {
		resultJSON, _ := json.Marshal(payload)
		g.eventBus.Publish(events.Event{
			Type: "cdap_command_response",
			Data: map[string]string{
				"peer_id":    dc.ID,
				"command_id": payload.CommandID,
				"status":     payload.Status,
				"result":     string(resultJSON),
			},
		})
	}

	g.auditAction("cdap_command_response", dc.ID, map[string]string{
		"command_id": payload.CommandID,
		"status":     payload.Status,
		"ip":         dc.ClientIP,
	})
}

// handleEvent processes custom events from the device.
func (g *Gateway) handleEvent(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload EventPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3006, "invalid event payload")
		return
	}

	if g.eventBus != nil {
		dataJSON, _ := json.Marshal(payload.Data)
		g.eventBus.Publish(events.Event{
			Type: "cdap_event",
			Data: map[string]string{
				"peer_id":    dc.ID,
				"event_type": payload.EventType,
				"data":       string(dataJSON),
			},
		})
	}
}

// handleLog processes log entries from the device.
func (g *Gateway) handleLog(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload LogPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3007, "invalid log payload")
		return
	}

	// Log at appropriate level
	level := strings.ToLower(payload.Level)
	if level == "error" || level == "critical" {
		log.Printf("[cdap] %s [%s]: %s", dc.ID, level, payload.Message)
	}

	// Publish to event bus
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "cdap_log",
			Data: map[string]string{
				"peer_id": dc.ID,
				"level":   payload.Level,
				"message": payload.Message,
			},
		})
	}
}

// handleHelpRequest persists a support request raised by an agent device and
// notifies operators via the event bus. The device identity is taken from the
// authenticated connection (dc.ID), never from the payload.
func (g *Gateway) handleHelpRequest(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload HelpRequestPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3008, "invalid help_request payload")
		return
	}

	message := strings.TrimSpace(payload.Message)
	if len(message) > 2048 {
		message = message[:2048]
	}

	hostname := strings.TrimSpace(payload.Hostname)
	if hostname == "" && dc.Manifest != nil {
		hostname = dc.Manifest.Device.Name
	}

	// Stamp the org the device belongs to (for operator data-scoping).
	orgID, _ := g.db.GetDeviceOrgID(dc.ID)

	req := &db.HelpRequest{
		DeviceID: dc.ID,
		Hostname: hostname,
		OrgID:    orgID,
		Message:  message,
		Status:   db.HelpStatusPending,
	}
	id, err := g.db.CreateHelpRequest(req)
	if err != nil {
		log.Printf("[cdap] %s: failed to save help request: %v", dc.ID, err)
		sendError(ctx, dc.conn, 5001, "failed to store help request")
		return
	}
	req.ID = id

	g.auditAction(string(audit.ActionHelpRequestCreated), dc.ID, map[string]string{
		"request_id": fmt.Sprintf("%d", id),
		"org_id":     orgID,
	})

	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: events.EventHelpRequest,
			Data: map[string]string{
				"id":        fmt.Sprintf("%d", id),
				"device_id": dc.ID,
				"hostname":  hostname,
				"org_id":    orgID,
				"message":   message,
				"status":    db.HelpStatusPending,
			},
		})
	}

	// Acknowledge to the device so it can confirm delivery.
	ack, _ := json.Marshal(map[string]any{"id": id, "status": db.HelpStatusPending})
	dc.WriteMessage(ctx, &Message{Type: "help_request_ack", Payload: ack})
}

// handleChatMessage persists a chat message from an agent device and notifies
// operators via the event bus. The sender identity is taken from the
// authenticated connection (dc.ID).
func (g *Gateway) handleChatMessage(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload ChatMessagePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3009, "invalid chat_message payload")
		return
	}

	text := strings.TrimSpace(payload.Text)
	if text == "" {
		sendError(ctx, dc.conn, 3009, "empty chat message")
		return
	}
	if len(text) > 4096 {
		text = text[:4096]
	}

	fromName := dc.ID
	if dc.Manifest != nil && dc.Manifest.Device.Name != "" {
		fromName = dc.Manifest.Device.Name
	}

	cm := &db.ChatMessage{
		ConversationID: dc.ID, // device <-> operator conversation keyed by device ID
		FromID:         dc.ID,
		FromName:       fromName,
		ToID:           payload.ToID,
		Text:           text,
	}
	id, err := g.db.SaveChatMessage(cm)
	if err != nil {
		log.Printf("[cdap] %s: failed to save chat message: %v", dc.ID, err)
		sendError(ctx, dc.conn, 5002, "failed to store chat message")
		return
	}
	cm.ID = id

	g.auditAction(string(audit.ActionChatMessage), dc.ID, map[string]string{
		"message_id": fmt.Sprintf("%d", id),
	})

	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "chat_message",
			Data: map[string]string{
				"id":              fmt.Sprintf("%d", id),
				"conversation_id": cm.ConversationID,
				"from_id":         cm.FromID,
				"from_name":       cm.FromName,
				"to_id":           cm.ToID,
				"text":            text,
			},
		})
	}

	// Acknowledge to the device.
	ack, _ := json.Marshal(map[string]any{"id": id})
	dc.WriteMessage(ctx, &Message{Type: "chat_message_ack", Payload: ack})
}

// handleUnregister processes a graceful disconnect from the device.
func (g *Gateway) handleUnregister(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload UnregisterPayload
	json.Unmarshal(msg.Payload, &payload) // best-effort parse

	log.Printf("[cdap] %s: unregistered (reason: %s)", dc.ID, payload.Reason)

	g.auditAction("cdap_unregister", dc.ID, map[string]string{
		"reason": payload.Reason,
		"ip":     dc.ClientIP,
	})
}

// handleTokenRefresh refreshes the device's JWT token.
func (g *Gateway) handleTokenRefresh(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload TokenRefreshPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3008, "invalid token_refresh payload")
		return
	}

	// Validate the existing token
	claims, err := g.jwt.Validate(dc.Token)
	if err != nil {
		sendError(ctx, dc.conn, 1003, "current token invalid")
		return
	}

	// Generate new token
	newToken, err := g.jwt.Generate(claims.Sub, dc.Role)
	if err != nil {
		sendError(ctx, dc.conn, 5001, "failed to generate token")
		return
	}

	dc.Token = newToken
	dc.TokenExpiry = time.Now().Add(g.jwt.Expiry())

	sendMessage(ctx, dc.conn, "token_refreshed", map[string]any{
		"token":      newToken,
		"expires_at": dc.TokenExpiry.UTC().Format(time.RFC3339),
	})
}

// collectWidgetState builds a flat map of all cached widget values for a device.
func collectWidgetState(dc *DeviceConn) map[string]any {
	state := make(map[string]any)
	dc.widgetState.Range(func(key, value any) bool {
		state[key.(string)] = value
		return true
	})
	return state
}

// handleTerminalOutput forwards terminal output from device to the browser.
func (g *Gateway) handleTerminalOutput(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload TerminalOutputPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	if payload.Stream == "" {
		payload.Stream = "stdout"
	}
	g.HandleTerminalOutput(ctx, payload.SessionID, payload.Data, payload.Stream)
}

// handleTerminalEnd processes device-initiated terminal session end.
func (g *Gateway) handleTerminalEnd(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload TerminalEndPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.EndTerminalSession(ctx, payload.SessionID, payload.Reason)
}

// handleDesktopFrame forwards a desktop frame from device to the browser.
func (g *Gateway) handleDesktopFrame(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload DesktopFramePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.HandleDesktopFrame(ctx, payload.SessionID, &payload)
}

// handleDesktopEnd processes device-initiated desktop session end.
func (g *Gateway) handleDesktopEnd(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload DesktopEndPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.EndDesktopSession(ctx, payload.SessionID, payload.Reason)
}

// handleDesktopConsentDenied ends the operator desktop session when the end user
// did not approve remote control.
func (g *Gateway) handleDesktopConsentDenied(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.SessionID == "" {
		return
	}
	g.EndDesktopSession(ctx, payload.SessionID, "consent_denied")
}

// handleVideoFrame forwards a video frame from device to the browser.
func (g *Gateway) handleVideoFrame(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload VideoFramePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.HandleVideoFrame(ctx, payload.SessionID, &payload)
}

// handleVideoEnd processes device-initiated video session end.
func (g *Gateway) handleVideoEnd(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload VideoEndPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.EndVideoSession(ctx, payload.SessionID, payload.Reason)
}

// handleFileResponse forwards a file browser response from device to browser.
func (g *Gateway) handleFileResponse(ctx context.Context, dc *DeviceConn, msg *Message) {
	// Extract session_id from the payload
	var base struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(msg.Payload, &base); err != nil || base.SessionID == "" {
		return
	}
	g.HandleFileResponse(ctx, base.SessionID, msg.Type, msg.Payload)
}

// handleFileEnd processes device-initiated file session end.
func (g *Gateway) handleFileEnd(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload FileEndPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.EndFileSession(ctx, payload.SessionID, payload.Reason)
}

// handleAudioFrame forwards an audio frame from device to the browser.
func (g *Gateway) handleAudioFrame(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload AudioFramePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.HandleAudioFrame(ctx, payload.SessionID, &payload)
}

// handleAudioEnd processes device-initiated audio session end.
func (g *Gateway) handleAudioEnd(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload AudioEndPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	if payload.SessionID == "" {
		return
	}
	g.EndAudioSession(ctx, payload.SessionID, payload.Reason)
}
