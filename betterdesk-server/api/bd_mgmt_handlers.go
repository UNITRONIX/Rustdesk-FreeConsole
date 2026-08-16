package api

// BetterDesk Desktop Client Management WebSocket
//
// Endpoint: GET /ws/bd-mgmt/{device_id}
//
// This WebSocket channel replaces CDAP for desktop clients. It provides:
//   - Device identification (the server marks the peer as betterdesk_desktop)
//   - Real-time management commands (remote-start, config-push, revoke)
//   - Heartbeat keep-alive (the WS connection itself proves liveness)
//
// Authentication: device_id must be a registered (non-banned, non-deleted) peer.
// The connection is lightweight — mostly idle, wakes on operator action.

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/unitronix/betterdesk-server/audit"
)

const (
	bdMgmtClockSkew           = 5 * time.Minute
	bdMgmtNonceTTL            = 10 * time.Minute
	bdMgmtPublicKeyConfigPref = "device_public_key_"
)

// bdMgmtMessage is the JSON envelope for management messages.
type bdMgmtMessage struct {
	Type      string          `json:"type"`
	DeviceID  string          `json:"device_id,omitempty"`
	Timestamp string          `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// bdMgmtSession tracks a single connected BetterDesk desktop client.
type bdMgmtSession struct {
	DeviceID  string
	Conn      *websocket.Conn
	Ctx       context.Context
	Cancel    context.CancelFunc
	SendCh    chan bdMgmtMessage
	CreatedAt time.Time
}

// bdMgmtHub manages all active BetterDesk desktop management sessions.
type bdMgmtHub struct {
	mu       sync.RWMutex
	sessions map[string]*bdMgmtSession // device_id -> session
}

var mgmtHub = &bdMgmtHub{
	sessions: make(map[string]*bdMgmtSession),
}

type bdMgmtNonceCache struct {
	mu    sync.Mutex
	items map[string]time.Time
}

var mgmtNonceCache = &bdMgmtNonceCache{items: make(map[string]time.Time)}

func (c *bdMgmtNonceCache) markUsed(key string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, exp := range c.items {
		if now.After(exp) {
			delete(c.items, k)
		}
	}
	if _, exists := c.items[key]; exists {
		return true
	}
	c.items[key] = now.Add(bdMgmtNonceTTL)
	return false
}

func bdMgmtSignaturePayload(deviceID, ts, nonce string) []byte {
	return fmt.Appendf(nil, "bd-mgmt-v1\n%s\n%s\n%s", deviceID, ts, nonce)
}

func canonicalizeDevicePublicKey(encoded string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("invalid base64 public key: %w", err)
	}
	if len(decoded) != ed25519.PublicKeySize {
		return "", fmt.Errorf("invalid public key length: %d", len(decoded))
	}
	return base64.StdEncoding.EncodeToString(decoded), nil
}

func (s *Server) storeBdMgmtPublicKey(deviceID, encoded string) error {
	canonical, err := canonicalizeDevicePublicKey(encoded)
	if err != nil {
		return err
	}
	return s.db.SetConfig(bdMgmtPublicKeyConfigPref+deviceID, canonical)
}

func (s *Server) loadBdMgmtPublicKey(deviceID string) ([]byte, error) {
	// An explicit management key is an Ed25519 identity bound during
	// enrollment. Prefer it over a generic peer PK, which may be a different
	// protocol's 32-byte key and therefore is not necessarily an Ed25519 key.
	stored, err := s.db.GetConfig(bdMgmtPublicKeyConfigPref + deviceID)
	if err != nil {
		return nil, err
	}
	if stored != "" {
		decoded, err := base64.StdEncoding.DecodeString(stored)
		if err != nil {
			return nil, fmt.Errorf("invalid stored public key: %w", err)
		}
		if len(decoded) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid stored public key length: %d", len(decoded))
		}
		return decoded, nil
	}

	if peerInfo, err := s.db.GetPeer(deviceID); err == nil && peerInfo != nil && len(peerInfo.PK) == ed25519.PublicKeySize {
		pk := make([]byte, len(peerInfo.PK))
		copy(pk, peerInfo.PK)
		return pk, nil
	}

	return nil, errors.New("no bound device public key")
}

func (s *Server) verifyBdMgmtRequest(r *http.Request, deviceID string) error {
	tsHeader := r.Header.Get("X-BD-Timestamp")
	nonce := r.Header.Get("X-BD-Nonce")
	sigHeader := r.Header.Get("X-BD-Signature")
	if tsHeader == "" || nonce == "" || sigHeader == "" {
		return errors.New("missing signed device headers")
	}

	unixTs, err := time.Parse(time.RFC3339, tsHeader)
	if err != nil {
		return fmt.Errorf("invalid timestamp: %w", err)
	}
	now := time.Now().UTC()
	delta := now.Sub(unixTs.UTC())
	if delta < 0 {
		delta = -delta
	}
	if delta > bdMgmtClockSkew {
		return errors.New("timestamp outside allowed skew")
	}

	pubKey, err := s.loadBdMgmtPublicKey(deviceID)
	if err != nil {
		return err
	}

	sig, err := base64.StdEncoding.DecodeString(sigHeader)
	if err != nil {
		return fmt.Errorf("invalid signature encoding: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid signature length: %d", len(sig))
	}

	payload := bdMgmtSignaturePayload(deviceID, tsHeader, nonce)
	if !ed25519.Verify(ed25519.PublicKey(pubKey), payload, sig) {
		return errors.New("invalid device signature")
	}

	cacheKey := deviceID + ":" + nonce
	if mgmtNonceCache.markUsed(cacheKey, now) {
		return errors.New("replayed device signature")
	}

	return nil
}

// Get returns the session for a device, or nil.
func (h *bdMgmtHub) Get(deviceID string) *bdMgmtSession {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[deviceID]
}

// Put stores a session, closing any previous one for the same device.
func (h *bdMgmtHub) Put(s *bdMgmtSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.sessions[s.DeviceID]; ok {
		old.Cancel()
		old.Conn.Close(websocket.StatusGoingAway, "replaced")
	}
	h.sessions[s.DeviceID] = s
}

// Remove deletes a session.
func (h *bdMgmtHub) Remove(deviceID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, deviceID)
}

// IsConnected checks if a BetterDesk desktop client is connected.
func (h *bdMgmtHub) IsConnected(deviceID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.sessions[deviceID]
	return ok
}

// SendToDevice sends a management message to a connected device.
func (h *bdMgmtHub) SendToDevice(deviceID string, msg bdMgmtMessage) bool {
	h.mu.RLock()
	s, ok := h.sessions[deviceID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case s.SendCh <- msg:
		return true
	default:
		// Channel full — device is slow, skip
		return false
	}
}

// ConnectedDevices returns all connected device IDs.
func (h *bdMgmtHub) ConnectedDevices() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]string, 0, len(h.sessions))
	for id := range h.sessions {
		ids = append(ids, id)
	}
	return ids
}

// ---------------------------------------------------------------------------
//  HTTP handler
// ---------------------------------------------------------------------------

// handleBdMgmt upgrades to WebSocket and runs the management session.
// Route: GET /ws/bd-mgmt/{device_id}
//
// Auth: Requires proof-of-possession using the device's bound Ed25519 key.
// The client must send signed headers before the WS upgrade is attempted:
//
//	X-BD-Timestamp: RFC3339 UTC timestamp
//	X-BD-Nonce:     unique per-connection nonce
//	X-BD-Signature: base64(Ed25519Sign("bd-mgmt-v1\n<device_id>\n<ts>\n<nonce>"))
func (s *Server) handleBdMgmt(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	if deviceID == "" || len(deviceID) < 3 || len(deviceID) > 32 {
		http.Error(w, "invalid device_id", http.StatusBadRequest)
		return
	}

	clientIP := s.remoteIP(r)
	peerInfo, err := s.db.GetPeer(deviceID)
	if err != nil {
		http.Error(w, "device lookup failed", http.StatusInternalServerError)
		return
	}
	if peerInfo == nil {
		http.Error(w, "unknown device", http.StatusUnauthorized)
		return
	}

	// Verify the device exists, is not banned, and is not deleted.
	if banned, _ := s.db.IsPeerBanned(deviceID); banned {
		log.Printf("[bd-mgmt] Rejected connection from %s — device %s is banned", clientIP, deviceID)
		http.Error(w, "device banned", http.StatusForbidden)
		return
	}
	if deleted, _ := s.db.IsPeerSoftDeleted(deviceID); deleted {
		log.Printf("[bd-mgmt] Rejected connection from %s — device %s is deleted", clientIP, deviceID)
		http.Error(w, "device deleted", http.StatusForbidden)
		return
	}

	if err := s.verifyBdMgmtRequest(r, deviceID); err != nil {
		log.Printf("[bd-mgmt] Rejected connection from %s for %s: %v", clientIP, deviceID, err)
		http.Error(w, "device authentication failed", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("[bd-mgmt] WebSocket accept error for %s: %v", deviceID, err)
		return
	}
	// SECURITY (audit fix I-02, 2026-04-10): cap inbound WebSocket frames at
	// 16 MiB so a misbehaving / hostile device cannot exhaust server memory
	// by streaming an unbounded JSON payload. The CDAP gateway has its own
	// 8 MiB cap; this channel allows slightly larger management blobs.
	conn.SetReadLimit(16 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	session := &bdMgmtSession{
		DeviceID:  deviceID,
		Conn:      conn,
		Ctx:       ctx,
		Cancel:    cancel,
		SendCh:    make(chan bdMgmtMessage, 16),
		CreatedAt: time.Now(),
	}

	mgmtHub.Put(session)
	log.Printf("[bd-mgmt] Device %s connected (proof-of-possession, ip: %s)", deviceID, clientIP)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerUpdated, clientIP, deviceID,
			map[string]string{"event": "bd_mgmt_connect", "auth": "device_signature"})
	}

	// Mark device as betterdesk_desktop in the database
	_ = s.db.UpdatePeerFields(deviceID, map[string]string{
		"device_type": "betterdesk_desktop",
	})

	// Send welcome message
	welcome := bdMgmtMessage{
		Type:      "welcome",
		DeviceID:  deviceID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	_ = wsjson.Write(ctx, conn, welcome)

	// Run read and write loops
	go session.writeLoop()
	session.readLoop(s)

	// Cleanup
	mgmtHub.Remove(deviceID)
	cancel()
	conn.Close(websocket.StatusNormalClosure, "session ended")
	log.Printf("[bd-mgmt] Device %s disconnected", deviceID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerUpdated, clientIP, deviceID,
			map[string]string{"event": "bd_mgmt_disconnect", "auth": "device_signature"})
	}
}

// readLoop reads messages from the device.
func (s *bdMgmtSession) readLoop(srv *Server) {
	for {
		var msg bdMgmtMessage
		err := wsjson.Read(s.Ctx, s.Conn, &msg)
		if err != nil {
			if s.Ctx.Err() != nil {
				return // context cancelled
			}
			log.Printf("[bd-mgmt] Read error from %s: %v", s.DeviceID, err)
			return
		}

		switch msg.Type {
		case "ping":
			// Respond with pong
			pong := bdMgmtMessage{
				Type:      "pong",
				Timestamp: time.Now().UTC().Format(time.RFC3339),
			}
			select {
			case s.SendCh <- pong:
			default:
			}

		case "pong":
			// Expected response to server ping — no action needed

		case "status":
			// Device status update — log and store
			log.Printf("[bd-mgmt] Status from %s: %s", s.DeviceID, string(msg.Payload))

		default:
			log.Printf("[bd-mgmt] Unknown message type from %s: %s", s.DeviceID, msg.Type)
		}
	}
}

// writeLoop sends messages to the device.
func (s *bdMgmtSession) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.Ctx.Done():
			return

		case msg := <-s.SendCh:
			if msg.Timestamp == "" {
				msg.Timestamp = time.Now().UTC().Format(time.RFC3339)
			}
			if err := wsjson.Write(s.Ctx, s.Conn, msg); err != nil {
				return
			}

		case <-ticker.C:
			// Server-side keepalive ping
			ping := bdMgmtMessage{
				Type:      "ping",
				Timestamp: time.Now().UTC().Format(time.RFC3339),
			}
			if err := wsjson.Write(s.Ctx, s.Conn, ping); err != nil {
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
//  REST helpers for the web panel to trigger management actions
// ---------------------------------------------------------------------------

// handleBdMgmtStatus returns the management channel status for a device.
// Route: GET /api/bd/mgmt/{device_id}/status
func (s *Server) handleBdMgmtStatus(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	connected := mgmtHub.IsConnected(deviceID)
	writeJSON(w, http.StatusOK, map[string]any{
		"device_id": deviceID,
		"connected": connected,
	})
}

// handleBdMgmtSend sends a management command to a connected device.
// Route: POST /api/bd/mgmt/{device_id}/send
func (s *Server) handleBdMgmtSend(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")

	var msg bdMgmtMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	msg.DeviceID = deviceID

	if mgmtHub.SendToDevice(deviceID, msg) {
		writeJSON(w, http.StatusOK, map[string]any{"sent": true})
	} else {
		http.Error(w, "device not connected", http.StatusNotFound)
	}
}

// handleBdMgmtConnected returns all connected BetterDesk desktop clients.
// Route: GET /api/bd/mgmt/connected
func (s *Server) handleBdMgmtConnected(w http.ResponseWriter, r *http.Request) {
	ids := mgmtHub.ConnectedDevices()
	writeJSON(w, http.StatusOK, map[string]any{
		"devices": ids,
		"count":   len(ids),
	})
}
