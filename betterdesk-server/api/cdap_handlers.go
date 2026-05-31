package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/cdap"
)

// commandCounter generates unique command IDs for CDAP commands.
var commandCounter atomic.Int64

// cdapDeviceIDRegexp validates CDAP device ID format:
//   - "CDAP-" + 6-16 hex chars  (e.g. CDAP-1A2B3C4D)
//   - "BD-"   + 16-32 hex chars (e.g. BD-37109D6FA4527A4C7A272E7D749C9D36)
//   - standard peer IDs: 1-64 alphanumeric/dash/underscore chars
var cdapDeviceIDRegexp = regexp.MustCompile(`^(CDAP-[A-Fa-f0-9]{6,16}|BD-[A-Fa-f0-9]{16,32}|[A-Za-z0-9_-]{1,64})$`)

type desktopWSMessage struct {
	Type        string          `json:"type"`
	InputType   string          `json:"input_type,omitempty"`
	X           int             `json:"x,omitempty"`
	Y           int             `json:"y,omitempty"`
	Button      int             `json:"button,omitempty"`
	Key         string          `json:"key,omitempty"`
	Code        string          `json:"code,omitempty"`
	Text        string          `json:"text,omitempty"`
	Modifiers   json.RawMessage `json:"modifiers,omitempty"`
	Down        *bool           `json:"down,omitempty"`
	DeltaX      int             `json:"delta_x,omitempty"`
	DeltaY      int             `json:"delta_y,omitempty"`
	DeltaXCamel int             `json:"deltaX,omitempty"`
	DeltaYCamel int             `json:"deltaY,omitempty"`
	Width       int             `json:"width,omitempty"`
	Height      int             `json:"height,omitempty"`
	Format      string          `json:"format,omitempty"`
	Data        string          `json:"data,omitempty"`
	SessionID   string          `json:"session_id,omitempty"`
	Index       int             `json:"index,omitempty"`
	Raw         json.RawMessage `json:"-"`
}

func buildDesktopInputPayload(msg *desktopWSMessage) *cdap.DesktopInputPayload {
	inputType := strings.ToLower(strings.TrimSpace(msg.InputType))
	switch inputType {
	case "mouse":
		mouseType := msg.Button & 7
		payload := &cdap.DesktopInputPayload{
			X:      msg.X,
			Y:      msg.Y,
			Button: decodeDesktopMouseButton(msg.Button >> 3),
			DeltaX: pickDesktopDelta(msg.DeltaX, msg.DeltaXCamel),
			DeltaY: pickDesktopDelta(msg.DeltaY, msg.DeltaYCamel),
		}
		switch mouseType {
		case 1:
			payload.Type = "mouse_down"
		case 2:
			payload.Type = "mouse_up"
		case 3:
			payload.Type = "mouse_scroll"
		default:
			payload.Type = "mouse_move"
		}
		return payload
	case "keyboard":
		pressed := msg.Down == nil || *msg.Down
		payload := &cdap.DesktopInputPayload{
			Key:       msg.Key,
			Code:      msg.Code,
			Modifiers: decodeDesktopModifiers(msg.Modifiers),
			Pressed:   pressed,
		}
		if pressed {
			payload.Type = "key_press"
		} else {
			payload.Type = "key_release"
		}
		return payload
	case "text":
		if strings.TrimSpace(msg.Text) == "" {
			return nil
		}
		return &cdap.DesktopInputPayload{
			Type: "text",
			Text: msg.Text,
		}
	default:
		return nil
	}
}

func pickDesktopDelta(primary, secondary int) int {
	if primary != 0 {
		return primary
	}
	return secondary
}

func decodeDesktopMouseButton(buttonBits int) int {
	switch buttonBits {
	case 1:
		return 1
	case 2:
		return 2
	case 4:
		return 3
	default:
		return 0
	}
}

func decodeDesktopModifiers(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}

	var flags map[string]bool
	if err := json.Unmarshal(raw, &flags); err == nil {
		modifiers := make([]string, 0, 4)
		if flags["ctrl"] || flags["control"] {
			modifiers = append(modifiers, "ctrl")
		}
		if flags["alt"] {
			modifiers = append(modifiers, "alt")
		}
		if flags["shift"] {
			modifiers = append(modifiers, "shift")
		}
		if flags["meta"] || flags["super"] {
			modifiers = append(modifiers, "super")
		}
		return modifiers
	}

	var modifiers []string
	if err := json.Unmarshal(raw, &modifiers); err == nil {
		return modifiers
	}

	return nil
}

// handleCDAPDeviceInfo returns full device info for a connected CDAP device.
// GET /api/cdap/devices/{id}
func (s *Server) handleCDAPDeviceInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	info := s.cdapGw.GetDeviceInfo(id)
	if info == nil {
		// Device not connected via CDAP — check if manifest exists in DB
		manifest, ok := s.cdapGw.GetDeviceManifest(id)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Device not found or not a CDAP device"})
			return
		}
		writeJSON(w, http.StatusOK, &cdap.DeviceInfo{
			ID:        id,
			Connected: false,
			Manifest:  manifest,
		})
		return
	}

	writeJSON(w, http.StatusOK, info)
}

// handleCDAPDeviceManifest returns the manifest for a CDAP device.
// GET /api/cdap/devices/{id}/manifest
func (s *Server) handleCDAPDeviceManifest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	manifest, ok := s.cdapGw.GetDeviceManifest(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "No manifest found for device"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(manifest)
}

// handleCDAPDeviceState returns current widget values for a connected CDAP device.
// GET /api/cdap/devices/{id}/state
func (s *Server) handleCDAPDeviceState(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	state, ok := s.cdapGw.GetDeviceWidgetState(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Device not connected"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"device_id":    id,
		"widget_state": state,
		"connected":    true,
	})
}

// handleCDAPSendCommand sends a command to a connected CDAP device.
// POST /api/cdap/devices/{id}/command
func (s *Server) handleCDAPSendCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	var body struct {
		WidgetID string `json:"widget_id"`
		Action   string `json:"action"`
		Value    any    `json:"value"`
		Reason   string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if body.WidgetID == "" || body.Action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "widget_id and action are required"})
		return
	}

	// Validate action
	validActions := map[string]bool{"set": true, "trigger": true, "execute": true, "reset": true, "query": true}
	if !validActions[body.Action] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid action. Must be: set, trigger, execute, reset, query"})
		return
	}

	operator := getUsernameFromCtx(r)
	operatorRole := getRoleFromCtx(r)

	// RBAC per-widget check: verify the operator's role has sufficient
	// privilege for the requested action on this widget.
	// Check delegation store for elevated access first.
	widget := s.cdapGw.GetWidget(id, body.WidgetID)
	if widget == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Widget not found on device"})
		return
	}

	effectiveRole := operatorRole
	if delegated := s.cdapGw.Delegations().GetEffectiveRole(operator, id, body.WidgetID); delegated != "" {
		if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
			effectiveRole = delegated
		}
	}

	if !cdap.CheckWidgetPermission(effectiveRole, body.Action, widget) {
		log.Printf("[cdap-api] RBAC denied: %s (role=%s, effective=%s) action=%s on widget %s/%s", operator, operatorRole, effectiveRole, body.Action, id, body.WidgetID)
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":     "Insufficient permissions for this widget action",
			"required":  cdap.EffectivePermissions(widget).Control,
			"your_role": effectiveRole,
		})
		return
	}

	commandID := fmt.Sprintf("cmd_%s_%d", id, commandCounter.Add(1))

	if err := s.cdapGw.SendCommandJSON(r.Context(), id, commandID, body.WidgetID, body.Action, body.Value, operator, body.Reason); err != nil {
		log.Printf("[cdap-api] SendCommand to %s failed: %v", id, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Device not connected or command failed"})
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]string{
		"status":     "sent",
		"command_id": commandID,
		"device_id":  id,
	})
}

// handleCDAPListDevices returns all connected CDAP devices with their info.
// GET /api/cdap/devices
func (s *Server) handleCDAPListDevices(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	ids := s.cdapGw.ListConnectedDevices()
	devices := make([]any, 0, len(ids))
	for _, id := range ids {
		if info := s.cdapGw.GetDeviceInfo(id); info != nil {
			devices = append(devices, info)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"devices": devices,
		"total":   len(devices),
	})
}

// handleCDAPStatus returns CDAP gateway status.
// GET /api/cdap/status
func (s *Server) handleCDAPStatus(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":   false,
			"connected": 0,
			"port":      0,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":   true,
		"connected": s.cdapGw.ActiveConnections(),
		"port":      s.cfg.CDAPPort,
		"tls":       s.cfg.CDAPTLSEnabled(),
	})
}

// handleCDAPAlerts returns all currently firing CDAP alerts.
// GET /api/cdap/alerts?device_id=optional
func (s *Server) handleCDAPAlerts(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	deviceID := r.URL.Query().Get("device_id")
	alerts := s.cdapGw.GetActiveAlerts(deviceID)
	if alerts == nil {
		alerts = make([]*cdap.AlertState, 0)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"alerts": alerts,
		"total":  len(alerts),
	})
}

// handleCDAPDelegateCreate creates a new auth delegation.
// POST /api/cdap/delegate
func (s *Server) handleCDAPDelegateCreate(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	// Only admins can create delegations
	role := getRoleFromCtx(r)
	if role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only admins can create delegations"})
		return
	}

	var body struct {
		Grantee   string   `json:"grantee"`
		DeviceID  string   `json:"device_id"`
		WidgetIDs []string `json:"widget_ids"` // empty = all widgets
		Role      string   `json:"role"`       // operator or admin
		Duration  int      `json:"duration"`   // seconds, max 86400 (24h)
		Reason    string   `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if body.Grantee == "" || body.DeviceID == "" || body.Role == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "grantee, device_id, and role are required"})
		return
	}

	if body.Role != "operator" && body.Role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be 'operator' or 'admin'"})
		return
	}

	if body.Duration <= 0 || body.Duration > 86400 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "duration must be 1-86400 seconds"})
		return
	}

	if !cdapDeviceIDRegexp.MatchString(body.DeviceID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	grantor := getUsernameFromCtx(r)
	delegationID := fmt.Sprintf("dlg_%d", commandCounter.Add(1))

	d := &cdap.Delegation{
		ID:        delegationID,
		Grantor:   grantor,
		Grantee:   body.Grantee,
		DeviceID:  body.DeviceID,
		WidgetIDs: body.WidgetIDs,
		Role:      body.Role,
		ExpiresAt: time.Now().Add(time.Duration(body.Duration) * time.Second),
		CreatedAt: time.Now(),
		Reason:    body.Reason,
	}

	if err := s.cdapGw.Delegations().Add(d); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[cdap-api] Delegation created: %s granted %s role=%s on device=%s by %s", delegationID, body.Grantee, body.Role, body.DeviceID, grantor)

	if s.auditLog != nil {
		s.auditLog.Log("cdap_delegation_created", s.remoteIP(r), grantor, map[string]string{
			"delegation_id": delegationID,
			"grantee":       body.Grantee,
			"device_id":     body.DeviceID,
			"role":          body.Role,
			"duration":      fmt.Sprintf("%ds", body.Duration),
		})
	}

	writeJSON(w, http.StatusCreated, d)
}

// handleCDAPDelegateRevoke revokes an active delegation.
// DELETE /api/cdap/delegate/{id}
func (s *Server) handleCDAPDelegateRevoke(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	role := getRoleFromCtx(r)
	if role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only admins can manage delegations"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Delegation ID required"})
		return
	}

	if !s.cdapGw.Delegations().Revoke(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Delegation not found or already expired"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log("cdap_delegation_revoked", s.remoteIP(r), getUsernameFromCtx(r), map[string]string{
			"delegation_id": id,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked", "id": id})
}

// handleCDAPDelegateList returns all active delegations.
// GET /api/cdap/delegations
func (s *Server) handleCDAPDelegateList(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	role := getRoleFromCtx(r)
	if role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only admins can view all delegations"})
		return
	}

	delegations := s.cdapGw.Delegations().ListAll()
	if delegations == nil {
		delegations = make([]*cdap.Delegation, 0)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"delegations": delegations,
		"total":       len(delegations),
	})
}

// handleCDAPTerminal upgrades the HTTP connection to a WebSocket and
// relays terminal I/O between the browser and a CDAP device.
// GET /api/cdap/devices/{id}/terminal
func (s *Server) handleCDAPTerminal(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)

	// RBAC: only admins (or delegated users) can open terminal sessions
	effectiveRole := role
	if s.cdapGw.Delegations() != nil {
		if delegated := s.cdapGw.Delegations().GetEffectiveRole(username, id, "terminal"); delegated != "" {
			if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
				effectiveRole = delegated
			}
		}
	}
	if effectiveRole != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Terminal access requires admin role"})
		return
	}

	// Accept WebSocket upgrade
	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-terminal"},
	})
	if err != nil {
		log.Printf("[cdap] Terminal WS upgrade failed for device %s: %v", id, err)
		return // Accept already wrote the HTTP error
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Read initial message from browser with terminal dimensions
	_, initData, err := wsConn.Read(ctx)
	if err != nil {
		log.Printf("[cdap] Terminal init read failed for device %s: %v", id, err)
		wsConn.Close(websocket.StatusProtocolError, "expected init message")
		return
	}

	var initMsg struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if err := json.Unmarshal(initData, &initMsg); err != nil {
		wsConn.Close(websocket.StatusProtocolError, "invalid init message")
		return
	}
	if initMsg.Cols < 1 {
		initMsg.Cols = 80
	}
	if initMsg.Rows < 1 {
		initMsg.Rows = 24
	}

	// Start terminal session on the device
	session, err := s.cdapGw.StartTerminalSession(ctx, wsConn, id, username, role, initMsg.Cols, initMsg.Rows)
	if err != nil {
		errMsg, _ := json.Marshal(map[string]string{
			"type":  "error",
			"error": fmt.Sprintf("Failed to start terminal: %v", err),
		})
		wsConn.Write(ctx, websocket.MessageText, errMsg)
		wsConn.Close(websocket.StatusInternalError, "terminal start failed")
		return
	}

	// Notify browser that session is ready
	readyMsg, _ := json.Marshal(map[string]string{
		"type":       "ready",
		"session_id": session.ID,
	})
	if err := wsConn.Write(ctx, websocket.MessageText, readyMsg); err != nil {
		s.cdapGw.EndTerminalSession(ctx, session.ID, "browser write failed")
		return
	}

	// Read loop: relay browser input/resize to device
	for {
		_, msgData, err := wsConn.Read(ctx)
		if err != nil {
			s.cdapGw.EndTerminalSession(ctx, session.ID, "browser disconnected")
			return
		}

		var msg struct {
			Type string `json:"type"`
			Data string `json:"data,omitempty"`
			Cols int    `json:"cols,omitempty"`
			Rows int    `json:"rows,omitempty"`
		}
		if err := json.Unmarshal(msgData, &msg); err != nil {
			continue // skip malformed messages
		}

		switch msg.Type {
		case "input":
			if err := s.cdapGw.RelayTerminalInput(ctx, session.ID, msg.Data); err != nil {
				s.cdapGw.EndTerminalSession(ctx, session.ID, "relay input failed")
				return
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				s.cdapGw.RelayTerminalResize(ctx, session.ID, msg.Cols, msg.Rows)
			}
		case "close":
			s.cdapGw.EndTerminalSession(ctx, session.ID, "user closed terminal")
			return
		}
	}
}

// handleCDAPDesktop handles WebSocket connections for remote desktop sessions.
func (s *Server) handleCDAPDesktop(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)

	effectiveRole := role
	if s.cdapGw.Delegations() != nil {
		if delegated := s.cdapGw.Delegations().GetEffectiveRole(username, id, "desktop"); delegated != "" {
			if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
				effectiveRole = delegated
			}
		}
	}
	if effectiveRole != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Desktop access requires admin role"})
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-desktop"},
	})
	if err != nil {
		log.Printf("[cdap] Desktop WS upgrade failed for device %s: %v", id, err)
		return
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Read init message with viewport size and quality preferences
	_, initData, err := wsConn.Read(ctx)
	if err != nil {
		wsConn.Close(websocket.StatusProtocolError, "expected init message")
		return
	}

	var initMsg struct {
		Width      int      `json:"width"`
		Height     int      `json:"height"`
		Quality    int      `json:"quality"`
		FPS        int      `json:"fps"`
		Codecs     []string `json:"codecs"`
		VideoCodec string   `json:"video_codec"`
	}
	if err := json.Unmarshal(initData, &initMsg); err != nil {
		wsConn.Close(websocket.StatusProtocolError, "invalid init message")
		return
	}

	session, err := s.cdapGw.StartDesktopSession(ctx, wsConn, id, username, role, initMsg.Width, initMsg.Height, initMsg.Quality, initMsg.FPS, initMsg.Codecs, initMsg.VideoCodec)
	if err != nil {
		errMsg, _ := json.Marshal(map[string]string{"type": "error", "error": fmt.Sprintf("Failed to start desktop: %v", err)})
		wsConn.Write(ctx, websocket.MessageText, errMsg)
		wsConn.Close(websocket.StatusInternalError, "desktop start failed")
		return
	}

	readyMsg, _ := json.Marshal(map[string]string{"type": "ready", "session_id": session.ID})
	if err := wsConn.Write(ctx, websocket.MessageText, readyMsg); err != nil {
		s.cdapGw.EndDesktopSession(ctx, session.ID, "browser write failed")
		return
	}

	// Dead-man switch (Phase 3.5): every browser read has a hard deadline.
	// The web client emits `presence_ping` every 15s; missing two pings in a
	// row terminates the session so a crashed/frozen operator browser does
	// not leave the agent capturing forever. The deadline resets on every
	// successful read, including pings.
	const desktopBrowserPresenceTimeout = 30 * time.Second

	for {
		readCtx, readCancel := context.WithTimeout(ctx, desktopBrowserPresenceTimeout)
		_, msgData, err := wsConn.Read(readCtx)
		readCancel()
		if err != nil {
			reason := "browser disconnected"
			if errors.Is(err, context.DeadlineExceeded) {
				reason = "browser presence timeout"
			}
			s.cdapGw.EndDesktopSession(ctx, session.ID, reason)
			return
		}

		var msg desktopWSMessage
		if err := json.Unmarshal(msgData, &msg); err != nil {
			continue
		}
		msg.Raw = json.RawMessage(msgData)

		switch msg.Type {
		case "presence_ping":
			// Read deadline already reset above — nothing else to do.
			continue
		case "input":
			input := buildDesktopInputPayload(&msg)
			if input == nil {
				continue
			}
			if err := s.cdapGw.RelayDesktopInput(ctx, session.ID, input); err != nil {
				s.cdapGw.EndDesktopSession(ctx, session.ID, "relay input failed")
				return
			}
		case "resize":
			if msg.Width > 0 && msg.Height > 0 {
				s.cdapGw.RelayDesktopResize(ctx, session.ID, msg.Width, msg.Height)
			}
		case "clipboard_set":
			if msg.Format != "" && msg.Data != "" {
				s.cdapGw.RelayClipboard(ctx, id, session.ID, msg.Format, msg.Data)
			}
		case "quality_report":
			s.cdapGw.HandleQualityReport(ctx, session.ID, msg.Raw)
		case "codec_offer":
			s.cdapGw.RelayCodecOffer(ctx, session.ID, msg.Raw)
		case "key_exchange":
			s.cdapGw.RelayKeyExchangeToDevice(ctx, session.ID, msg.Raw)
		case "keyframe_request":
			s.cdapGw.RelayKeyframeRequest(ctx, session.ID)
		case "monitor_select":
			s.cdapGw.RelayMonitorSelect(ctx, session.ID, msg.Index)
		case "close":
			s.cdapGw.EndDesktopSession(ctx, session.ID, "user closed desktop")
			return
		}
	}
}

// handleCDAPVideo handles WebSocket connections for video stream sessions.
func (s *Server) handleCDAPVideo(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)

	// RBAC: operator+ can access video streams (must check BEFORE WS upgrade)
	effectiveRole := role
	if s.cdapGw.Delegations() != nil {
		if delegated := s.cdapGw.Delegations().GetEffectiveRole(username, id, "video"); delegated != "" {
			if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
				effectiveRole = delegated
			}
		}
	}
	if cdap.RoleLevel(effectiveRole) < cdap.RoleLevel("operator") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Video access requires operator role"})
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-video"},
	})
	if err != nil {
		log.Printf("[cdap] Video WS upgrade failed for device %s: %v", id, err)
		return
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	_, initData, err := wsConn.Read(ctx)
	if err != nil {
		wsConn.Close(websocket.StatusProtocolError, "expected init message")
		return
	}

	var initMsg struct {
		StreamID string `json:"stream_id"`
		Quality  int    `json:"quality"`
		FPS      int    `json:"fps"`
	}
	if err := json.Unmarshal(initData, &initMsg); err != nil {
		wsConn.Close(websocket.StatusProtocolError, "invalid init message")
		return
	}

	session, err := s.cdapGw.StartVideoSession(ctx, wsConn, id, username, role, initMsg.StreamID, initMsg.Quality, initMsg.FPS)
	if err != nil {
		errMsg, _ := json.Marshal(map[string]string{"type": "error", "error": fmt.Sprintf("Failed to start video: %v", err)})
		wsConn.Write(ctx, websocket.MessageText, errMsg)
		wsConn.Close(websocket.StatusInternalError, "video start failed")
		return
	}

	readyMsg, _ := json.Marshal(map[string]string{"type": "ready", "session_id": session.ID})
	if err := wsConn.Write(ctx, websocket.MessageText, readyMsg); err != nil {
		s.cdapGw.EndVideoSession(ctx, session.ID, "browser write failed")
		return
	}

	// Read loop: only handle close messages (video is unidirectional)
	for {
		_, msgData, err := wsConn.Read(ctx)
		if err != nil {
			s.cdapGw.EndVideoSession(ctx, session.ID, "browser disconnected")
			return
		}

		var msg struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msgData, &msg) == nil {
			switch msg.Type {
			case "close":
				s.cdapGw.EndVideoSession(ctx, session.ID, "user closed video")
				return
			case "quality_report":
				s.cdapGw.HandleQualityReport(ctx, session.ID, json.RawMessage(msgData))
			case "codec_offer":
				s.cdapGw.RelayCodecOffer(ctx, session.ID, json.RawMessage(msgData))
			case "key_exchange":
				s.cdapGw.RelayKeyExchangeToDevice(ctx, session.ID, json.RawMessage(msgData))
			case "keyframe_request":
				s.cdapGw.RelayKeyframeRequest(ctx, session.ID)
			}
		}
	}
}

// handleCDAPFileBrowser handles WebSocket connections for file browser sessions.
func (s *Server) handleCDAPFileBrowser(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)

	effectiveRole := role
	if s.cdapGw.Delegations() != nil {
		if delegated := s.cdapGw.Delegations().GetEffectiveRole(username, id, "file_browser"); delegated != "" {
			if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
				effectiveRole = delegated
			}
		}
	}
	if effectiveRole != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "File browser access requires admin role"})
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-filebrowser"},
	})
	if err != nil {
		log.Printf("[cdap] File browser WS upgrade failed for device %s: %v", id, err)
		return
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	session, err := s.cdapGw.StartFileSession(ctx, wsConn, id, username, role)
	if err != nil {
		errMsg, _ := json.Marshal(map[string]string{"type": "error", "error": fmt.Sprintf("Failed to start file browser: %v", err)})
		wsConn.Write(ctx, websocket.MessageText, errMsg)
		wsConn.Close(websocket.StatusInternalError, "file start failed")
		return
	}

	readyMsg, _ := json.Marshal(map[string]string{"type": "ready", "session_id": session.ID})
	if err := wsConn.Write(ctx, websocket.MessageText, readyMsg); err != nil {
		s.cdapGw.EndFileSession(ctx, session.ID, "browser write failed")
		return
	}

	for {
		_, msgData, err := wsConn.Read(ctx)
		if err != nil {
			s.cdapGw.EndFileSession(ctx, session.ID, "browser disconnected")
			return
		}

		var msg struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data,omitempty"`
		}
		if err := json.Unmarshal(msgData, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "file_list", "file_read", "file_write", "file_delete":
			if err := s.cdapGw.RelayFileRequest(ctx, session.ID, msg.Type, msg.Data); err != nil {
				s.cdapGw.EndFileSession(ctx, session.ID, "relay request failed")
				return
			}
		case "close":
			s.cdapGw.EndFileSession(ctx, session.ID, "user closed file browser")
			return
		}
	}
}

// handleCDAPAudio handles WebSocket connections for audio stream sessions.
// GET /api/cdap/devices/{id}/audio
func (s *Server) handleCDAPAudio(w http.ResponseWriter, r *http.Request) {
	if s.cdapGw == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "CDAP gateway not enabled"})
		return
	}

	id := r.PathValue("id")
	if !cdapDeviceIDRegexp.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid device ID"})
		return
	}

	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)

	// RBAC: operator+ can access audio streams
	effectiveRole := role
	if s.cdapGw.Delegations() != nil {
		if delegated := s.cdapGw.Delegations().GetEffectiveRole(username, id, "audio"); delegated != "" {
			if cdap.RoleLevel(delegated) > cdap.RoleLevel(effectiveRole) {
				effectiveRole = delegated
			}
		}
	}
	if cdap.RoleLevel(effectiveRole) < cdap.RoleLevel("operator") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Audio access requires operator role"})
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-audio"},
	})
	if err != nil {
		log.Printf("[cdap] Audio WS upgrade failed for device %s: %v", id, err)
		return
	}
	defer wsConn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	_, initData, err := wsConn.Read(ctx)
	if err != nil {
		wsConn.Close(websocket.StatusProtocolError, "expected init message")
		return
	}

	var initMsg struct {
		Codec      string `json:"codec"`
		SampleRate int    `json:"sample_rate"`
		Channels   int    `json:"channels"`
		Direction  string `json:"direction"`
	}
	if err := json.Unmarshal(initData, &initMsg); err != nil {
		wsConn.Close(websocket.StatusProtocolError, "invalid init message")
		return
	}

	session, err := s.cdapGw.StartAudioSession(ctx, wsConn, id, username, role, initMsg.Codec, initMsg.SampleRate, initMsg.Channels, initMsg.Direction)
	if err != nil {
		errMsg, _ := json.Marshal(map[string]string{"type": "error", "error": fmt.Sprintf("Failed to start audio: %v", err)})
		wsConn.Write(ctx, websocket.MessageText, errMsg)
		wsConn.Close(websocket.StatusInternalError, "audio start failed")
		return
	}

	readyMsg, _ := json.Marshal(map[string]string{"type": "ready", "session_id": session.ID})
	if err := wsConn.Write(ctx, websocket.MessageText, readyMsg); err != nil {
		s.cdapGw.EndAudioSession(ctx, session.ID, "browser write failed")
		return
	}

	for {
		_, msgData, err := wsConn.Read(ctx)
		if err != nil {
			s.cdapGw.EndAudioSession(ctx, session.ID, "browser disconnected")
			return
		}

		var msg struct {
			Type      string `json:"type"`
			Codec     string `json:"codec,omitempty"`
			Data      string `json:"data,omitempty"`
			Timestamp int64  `json:"timestamp,omitempty"`
		}
		if err := json.Unmarshal(msgData, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "audio_input":
			if msg.Data != "" {
				s.cdapGw.RelayAudioInput(ctx, session.ID, msg.Codec, msg.Data, msg.Timestamp)
			}
		case "key_exchange":
			s.cdapGw.RelayKeyExchangeToDevice(ctx, session.ID, json.RawMessage(msgData))
		case "close":
			s.cdapGw.EndAudioSession(ctx, session.ID, "user closed audio")
			return
		}
	}
}
