package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

// ---------------------------------------------------------------------------
//  Branding configuration — served to desktop clients (public, no auth)
// ---------------------------------------------------------------------------

// BrandingConfig is the payload returned by GET /api/branding.
// Desktop clients fetch this to apply company theming.
type BrandingConfig struct {
	CompanyName    string            `json:"company_name"`
	AccentColor    string            `json:"accent_color"`
	SupportContact string            `json:"support_contact"`
	Colors         map[string]string `json:"colors,omitempty"`
	SyncModes      []SyncModeOption  `json:"sync_modes"`
}

// SyncModeOption describes a sync speed tier for enrollment approval UI.
type SyncModeOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

var defaultSyncModes = []SyncModeOption{
	{ID: "silent", Label: "Silent", Description: "Minimal telemetry — CPU/RAM every 60s, no software scan"},
	{ID: "standard", Label: "Standard", Description: "Balanced — 30s telemetry, 5min disk, 6h software"},
	{ID: "turbo", Label: "Turbo", Description: "Aggressive — 10s telemetry, 1min disk, 30min software"},
}

// handleGetBranding returns the branding configuration.
// Public endpoint — no authentication required.
// GET /api/branding
func (s *Server) handleGetBranding(w http.ResponseWriter, r *http.Request) {
	cfg := BrandingConfig{
		CompanyName:    "BetterDesk",
		AccentColor:    "#4f6ef7",
		SupportContact: "",
		SyncModes:      defaultSyncModes,
	}

	// Load overrides from server_config
	if v, err := s.db.GetConfig("branding_company_name"); err == nil && v != "" {
		cfg.CompanyName = v
	}
	if v, err := s.db.GetConfig("branding_accent_color"); err == nil && v != "" {
		cfg.AccentColor = v
	}
	if v, err := s.db.GetConfig("branding_support_contact"); err == nil && v != "" {
		cfg.SupportContact = v
	}
	if v, err := s.db.GetConfig("branding_colors"); err == nil && v != "" {
		var colors map[string]string
		if json.Unmarshal([]byte(v), &colors) == nil {
			cfg.Colors = colors
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg)
}

// handleSaveBranding saves branding configuration. Admin only.
// POST /api/branding
func (s *Server) handleSaveBranding(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CompanyName    *string           `json:"company_name"`
		AccentColor    *string           `json:"accent_color"`
		SupportContact *string           `json:"support_contact"`
		Colors         map[string]string `json:"colors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.CompanyName != nil {
		s.db.SetConfig("branding_company_name", *req.CompanyName)
	}
	if req.AccentColor != nil {
		s.db.SetConfig("branding_accent_color", *req.AccentColor)
	}
	if req.SupportContact != nil {
		s.db.SetConfig("branding_support_contact", *req.SupportContact)
	}
	if req.Colors != nil {
		if data, err := json.Marshal(req.Colors); err == nil {
			s.db.SetConfig("branding_colors", string(data))
		}
	}

	if s.auditLog != nil {
		s.auditLog.Log("branding_updated", s.remoteIP(r), getUsernameFromCtx(r), nil)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// ---------------------------------------------------------------------------
//  Device enrollment — desktop client self-registration
// ---------------------------------------------------------------------------

// EnrollmentRequest is sent by the BetterDesk desktop client on first connect.
type EnrollmentRequest struct {
	DeviceID   string `json:"device_id"`
	UUID       string `json:"uuid"`
	Hostname   string `json:"hostname"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	DeviceType string `json:"device_type,omitempty"` // "betterdesk", "rustdesk", "os_agent", etc.
	BundleID   string `json:"bundle_id,omitempty"`
	Tags       string `json:"tags,omitempty"` // comma-separated enrollment metadata
	PublicKey  string `json:"public_key,omitempty"`
	Token      string `json:"token,omitempty"` // Optional enrollment credential, POST body only
}

// EnrollmentResponse is returned to the desktop client.
type EnrollmentResponse struct {
	Status            string          `json:"status"` // approved, pending, rejected
	DeviceID          string          `json:"device_id"`
	DeviceToken       string          `json:"device_token,omitempty"`
	ServerTime        int64           `json:"server_time"`
	SyncMode          string          `json:"sync_mode,omitempty"`    // silent, standard, turbo
	DisplayName       string          `json:"display_name,omitempty"` // Operator-assigned name
	Branding          *BrandingConfig `json:"branding,omitempty"`     // Inline branding
	ServerKey         string          `json:"server_key,omitempty"`   // Ed25519 public key (base64)
	HeartbeatSec      int             `json:"heartbeat_interval"`     // Heartbeat interval
	Message           string          `json:"message,omitempty"`      // Human-readable message
	Error             string          `json:"error,omitempty"`
	SuggestedDeviceID string          `json:"suggested_device_id,omitempty"`
}

// handleDeviceRegister handles desktop client self-registration.
// POST /api/devices/register
//
// In "open" mode: device is immediately approved.
// In "managed" mode: device is placed in pending state until operator approves.
// In "locked" mode: device needs a valid enrollment token.
func (s *Server) handleDeviceRegister(w http.ResponseWriter, r *http.Request) {
	var req EnrollmentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.DeviceID == "" {
		http.Error(w, "device_id is required", http.StatusBadRequest)
		return
	}
	if req.PublicKey != "" {
		if _, err := canonicalizeDevicePublicKey(req.PublicKey); err != nil {
			http.Error(w, "invalid public_key", http.StatusBadRequest)
			return
		}
	}

	clientIP := s.remoteIP(r)
	mode := s.cfg.EnrollmentMode
	if mode == "" {
		mode = "open"
	}

	// Enrollment decisions and lifecycle blocks take precedence over an
	// existing peer row. In particular, reject+ban creates a peer solely to
	// retain audit metadata, so checking it after the existing-peer fast path
	// would incorrectly approve that device and could reissue a credential.
	if banned, _ := s.db.IsPeerBanned(req.DeviceID); banned {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: req.DeviceID,
			Message:  "Device is banned",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}
	if removed, _ := s.db.IsPeerSoftDeleted(req.DeviceID); removed {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: req.DeviceID,
			Message:  "Device has been removed",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}
	if rejected, _ := s.db.GetConfig(rejectedDevicePrefix + req.DeviceID); rejected != "" {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: req.DeviceID,
			Message:  "Device enrollment was rejected",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Check if device already exists (re-registration = always approve)
	existing, _ := s.db.GetPeer(req.DeviceID)
	if existing != nil {
		if req.UUID != "" && existing.UUID != "" && req.UUID != existing.UUID {
			resp := EnrollmentResponse{
				Status:            "rejected",
				DeviceID:          req.DeviceID,
				Error:             "identity_conflict",
				Message:           "Device ID is already registered to a different machine",
				SuggestedDeviceID: suggestAlternateDeviceID(req.DeviceID),
				ServerTime:        timeNowUnixMilli(),
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(resp)
			return
		}
		// An already-enrolled device must never be allowed to replace its
		// public key through an unauthenticated re-registration request.
		var boundKeyErr error
		if req.PublicKey != "" {
			incomingCanonical, _ := canonicalizeDevicePublicKey(req.PublicKey)
			if bound, err := s.loadBdMgmtPublicKey(req.DeviceID); err == nil {
				boundCanonical := base64.StdEncoding.EncodeToString(bound)
				if incomingCanonical != boundCanonical {
					http.Error(w, "public_key does not match enrolled device identity", http.StatusForbidden)
					return
				}
			} else {
				boundKeyErr = err
			}
		} else {
			_, boundKeyErr = s.loadBdMgmtPublicKey(req.DeviceID)
		}

		// Device already known — return approved with current config
		syncMode, _ := s.db.GetConfig("device_sync_mode_" + req.DeviceID)
		if syncMode == "" {
			syncMode = "standard"
		}
		displayName, _ := s.db.GetConfig("device_display_name_" + req.DeviceID)

		resp := s.buildEnrollmentResponse("approved", req.DeviceID, syncMode, displayName)
		// Reissuing a token is privileged: require either the existing
		// device-bound credential or a replay-protected proof of possession of
		// the key already bound to this device. A UUID alone is metadata, not a
		// secret, and must never authorize token recovery.
		hasBoundCredential := s.hasEnrollmentCredential(
			req.DeviceID,
			enrollmentTokenCandidates(r, req.Token),
			true,
		)
		authorized := s.authorizeEnrollmentTokenIssue(r, req.DeviceID, req.PublicKey, req.Token, true)
		if authorized {
			// A legacy device can attach a management key only after proving
			// possession of a bound device token. Without that credential,
			// accepting a new key here would let an attacker seize the identity.
			if boundKeyErr != nil && req.PublicKey != "" {
				if err := s.storeBdMgmtPublicKey(req.DeviceID, req.PublicKey); err != nil {
					log.Printf("[API] Failed to bind public key for %s: %v", req.DeviceID, err)
				}
			}
			// A normal authenticated refresh must not rotate/re-emit a usable
			// device token. Only recovery with proof but without an active
			// bound credential gets a replacement.
			if !hasBoundCredential {
				if token, err := s.issueEnrollmentDeviceToken(req.DeviceID); err == nil {
					resp.DeviceToken = token
					log.Printf("[API] Re-issued enrollment device token for %s (len=%d)", req.DeviceID, len(token))
				} else {
					log.Printf("[API] Failed to re-issue enrollment device token for %s: %v", req.DeviceID, err)
				}
			}
		} else {
			resp.Message = "Device identity proof is required to issue a device token"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	switch mode {
	case "open":
		// Auto-approve: create peer immediately
		s.createPeerFromEnrollment(&req, clientIP)
		resp := s.buildEnrollmentResponse("approved", req.DeviceID, "standard", "")
		// Open mode admits a new device, but it does not make an unauthenticated
		// request eligible to receive a reusable device credential. The first
		// request can prove possession of its supplied key; a later status poll
		// can use that now-bound key if the first request did not include proof.
		if s.authorizeEnrollmentTokenIssue(r, req.DeviceID, req.PublicKey, req.Token, false) {
			if token, err := s.issueEnrollmentDeviceToken(req.DeviceID); err == nil {
				resp.DeviceToken = token
			} else {
				log.Printf("[API] Failed to auto-issue enrollment device token for %s: %v", req.DeviceID, err)
			}
		} else {
			resp.Message = "Device identity proof is required to issue a device token"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)

		if s.auditLog != nil {
			s.auditLog.Log("device_enrolled", clientIP, req.DeviceID, map[string]string{
				"mode": "open", "hostname": req.Hostname,
			})
		}

	case "managed":
		// Each support-agent installation registers without a shared bundle token.
		// Operator approval issues a unique device_token per device.
		if err := s.storePendingDevice(&req, clientIP); err != nil {
			resp := EnrollmentResponse{
				Status:            "rejected",
				DeviceID:          req.DeviceID,
				Error:             "identity_conflict",
				Message:           "Device ID is already pending for a different machine",
				SuggestedDeviceID: suggestAlternateDeviceID(req.DeviceID),
				ServerTime:        timeNowUnixMilli(),
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(resp)
			return
		}
		resp := EnrollmentResponse{
			Status:       "pending",
			DeviceID:     req.DeviceID,
			ServerTime:   timeNowUnixMilli(),
			HeartbeatSec: 5, // Poll faster while pending
			Message:      "Waiting for operator approval",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(resp)

		if s.auditLog != nil {
			s.auditLog.Log("device_pending", clientIP, req.DeviceID, map[string]string{
				"hostname": req.Hostname, "platform": req.Platform,
			})
		}

		// Emit event for web panel real-time update
		if s.eventBus != nil {
			s.eventBus.Publish(events.Event{
				Type: "device_pending",
				Data: map[string]string{
					"device_id": req.DeviceID,
					"hostname":  req.Hostname,
					"platform":  req.Platform,
					"ip":        clientIP,
				},
			})
		}

	case "locked":
		// Only allow enrollment with a valid token
		if req.Token != "" {
			if tok, err := s.db.ValidateToken(hashToken(req.Token)); err == nil && tok != nil &&
				(tok.PeerID == "" || tok.PeerID == req.DeviceID) {
				// Valid token — activate and bind to this device, then approve
				if tok.Status == "pending" {
					_ = s.db.BindTokenToPeer(tok.TokenHash, req.DeviceID)
				}
				_ = s.db.IncrementTokenUse(tok.TokenHash)
				s.createPeerFromEnrollment(&req, clientIP)
				resp := s.buildEnrollmentResponse("approved", req.DeviceID, "standard", "")
				if deviceToken, err := s.issueEnrollmentDeviceToken(req.DeviceID); err == nil {
					resp.DeviceToken = deviceToken
				} else {
					log.Printf("[API] Failed to issue device token after token-enroll for %s: %v", req.DeviceID, err)
					resp.DeviceToken = req.Token
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(resp)

				if s.auditLog != nil {
					s.auditLog.Log("device_enrolled", clientIP, req.DeviceID, map[string]string{
						"mode": "locked", "method": "token", "hostname": req.Hostname,
					})
				}
				return
			}
		}

		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: req.DeviceID,
			Message:  "Enrollment is locked — a valid token is required",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
	}
}

// handleDeviceRegisterStatus lets the client poll its enrollment status.
// GET /api/devices/register/status?device_id=X
func (s *Server) handleDeviceRegisterStatus(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		http.Error(w, "device_id query param required", http.StatusBadRequest)
		return
	}

	// A banned, removed, or explicitly rejected device must not use the
	// otherwise-public status endpoint to obtain an approved response or a
	// replacement token.
	if banned, _ := s.db.IsPeerBanned(deviceID); banned {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: deviceID,
			Message:  "Device is banned",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}
	if removed, _ := s.db.IsPeerSoftDeleted(deviceID); removed {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: deviceID,
			Message:  "Device has been removed",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}
	if rejected, _ := s.db.GetConfig(rejectedDevicePrefix + deviceID); rejected != "" {
		resp := EnrollmentResponse{
			Status:   "rejected",
			DeviceID: deviceID,
			Message:  "Device enrollment was rejected",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Check if approved (exists in peers table)
	if peer, _ := s.db.GetPeer(deviceID); peer != nil {
		if peer.Banned || peer.Disabled || peer.SoftDeleted {
			resp := EnrollmentResponse{
				Status:     "rejected",
				DeviceID:   deviceID,
				ServerTime: timeNowUnixMilli(),
				Message:    "Device enrollment is no longer active",
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(resp)
			return
		}
		syncMode, _ := s.db.GetConfig("device_sync_mode_" + deviceID)
		if syncMode == "" {
			syncMode = "standard"
		}
		displayName, _ := s.db.GetConfig("device_display_name_" + deviceID)
		resp := s.buildEnrollmentResponse("approved", deviceID, syncMode, displayName)
		// Status polling remains available for enrollment state, but token
		// issuance requires the device-bound credential or a signed proof.
		hasBoundCredential := s.hasEnrollmentCredential(
			deviceID,
			enrollmentTokenCandidates(r, ""),
			true,
		)
		if !hasBoundCredential && s.authorizeEnrollmentTokenIssue(r, deviceID, "", "", true) {
			if token, err := s.issueEnrollmentDeviceToken(deviceID); err == nil {
				resp.DeviceToken = token
			} else {
				log.Printf("[API] Failed to issue enrollment device token on status poll for %s: %v", deviceID, err)
			}
		} else {
			resp.Message = "Device identity proof is required to issue a device token"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Check if pending
	pending, _ := s.db.GetConfig("pending_device_" + deviceID)
	if pending != "" {
		resp := EnrollmentResponse{
			Status:       "pending",
			DeviceID:     deviceID,
			ServerTime:   timeNowUnixMilli(),
			HeartbeatSec: 5,
			Message:      "Waiting for operator approval",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Unknown — not registered
	resp := EnrollmentResponse{
		Status:   "unknown",
		DeviceID: deviceID,
		Message:  "Device not found — register first",
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	json.NewEncoder(w).Encode(resp)
}

// ---------------------------------------------------------------------------
//  Enrollment management — operator approval (admin/operator only)
// ---------------------------------------------------------------------------

const (
	enrollmentDecisionPrefix  = "enrollment_decision_"
	rejectedDevicePrefix      = "rejected_device_"
	pendingDevicePrefix       = "pending_device_"
	enrollmentRejectBanReason = "enrollment rejected"
)

// enrollmentDecision is persisted under enrollment_decision_<id> so Approved /
// Rejected filters can show Go enrollment history (#351).
type enrollmentDecision struct {
	DeviceID   string `json:"device_id"`
	UUID       string `json:"uuid,omitempty"`
	Hostname   string `json:"hostname"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	DeviceType string `json:"device_type,omitempty"`
	BundleID   string `json:"bundle_id,omitempty"`
	Tags       string `json:"tags,omitempty"`
	IP         string `json:"ip"`
	Status     string `json:"status"` // approved | rejected
	Banned     bool   `json:"banned"`
	DecidedAt  string `json:"decided_at"`
	CreatedAt  string `json:"created_at,omitempty"`
	Actor      string `json:"actor,omitempty"`
}

type pendingEnrollmentMeta struct {
	DeviceID   string `json:"device_id"`
	UUID       string `json:"uuid"`
	Hostname   string `json:"hostname"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	DeviceType string `json:"device_type,omitempty"`
	BundleID   string `json:"bundle_id,omitempty"`
	Tags       string `json:"tags,omitempty"`
	PublicKey  string `json:"public_key"`
	IP         string `json:"ip"`
	CreatedAt  string `json:"created_at"`
}

func parsePendingEnrollmentMeta(raw string) pendingEnrollmentMeta {
	var meta pendingEnrollmentMeta
	if raw == "" {
		return meta
	}
	_ = json.Unmarshal([]byte(raw), &meta)
	return meta
}

func (s *Server) storeEnrollmentDecision(d enrollmentDecision) {
	if d.DeviceID == "" {
		return
	}
	data, err := json.Marshal(d)
	if err != nil {
		log.Printf("[API] storeEnrollmentDecision: marshal failed for %s: %v", d.DeviceID, err)
		return
	}
	if err := s.db.SetConfig(enrollmentDecisionPrefix+d.DeviceID, string(data)); err != nil {
		log.Printf("[API] storeEnrollmentDecision: store failed for %s: %v", d.DeviceID, err)
	}
}

func (s *Server) clearEnrollmentRejectionState(deviceID string) {
	if deviceID == "" || s.db == nil {
		return
	}
	_ = s.db.DeleteConfig(rejectedDevicePrefix + deviceID)
	// Keep approved history; only drop rejection decisions so Filters stay accurate.
	if raw, err := s.db.GetConfig(enrollmentDecisionPrefix + deviceID); err == nil && raw != "" {
		var d enrollmentDecision
		if json.Unmarshal([]byte(raw), &d) == nil && d.Status == "rejected" {
			_ = s.db.DeleteConfig(enrollmentDecisionPrefix + deviceID)
		}
	}
}

// handleListPendingDevices returns all pending enrollment requests.
// GET /api/enrollment/pending
func (s *Server) handleListPendingDevices(w http.ResponseWriter, r *http.Request) {
	// Pending devices are stored as server_config entries: pending_device_<id> = JSON
	// We scan all config keys with this prefix.
	// Note: For production scale, a dedicated table would be better.
	// Using server_config for now since it's available and simple.

	// List all pending_ entries
	pending := s.listPendingDevices()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"devices": pending,
		"count":   len(pending),
	})
}

// handleListEnrollmentHistory returns approved/rejected Go enrollment decisions.
// GET /api/enrollment/history?status=approved|rejected
func (s *Server) handleListEnrollmentHistory(w http.ResponseWriter, r *http.Request) {
	statusFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if statusFilter != "" && statusFilter != "approved" && statusFilter != "rejected" {
		http.Error(w, "Invalid status (approved, rejected)", http.StatusBadRequest)
		return
	}

	devices := s.listEnrollmentHistory(statusFilter)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"devices": devices,
		"count":   len(devices),
	})
}

func (s *Server) listEnrollmentHistory(statusFilter string) []enrollmentDecision {
	var result []enrollmentDecision
	configs, err := s.db.ListConfigByPrefix(enrollmentDecisionPrefix)
	if err != nil {
		log.Printf("[API] listEnrollmentHistory: %v", err)
		return result
	}
	for _, cfg := range configs {
		var d enrollmentDecision
		if json.Unmarshal([]byte(cfg.Value), &d) != nil || d.DeviceID == "" {
			continue
		}
		if statusFilter != "" && d.Status != statusFilter {
			continue
		}
		result = append(result, d)
	}
	return result
}

// handleApproveDevice approves a pending enrollment request.
// POST /api/enrollment/approve/{id}
func (s *Server) handleApproveDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	if deviceID == "" {
		http.Error(w, "Device ID required", http.StatusBadRequest)
		return
	}

	var req struct {
		DisplayName string `json:"display_name"`
		SyncMode    string `json:"sync_mode"` // silent, standard, turbo
		Tags        string `json:"tags"`      // comma-separated tag list
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate sync mode
	syncMode := strings.ToLower(req.SyncMode)
	if syncMode == "" {
		syncMode = "standard"
	}
	if syncMode != "silent" && syncMode != "standard" && syncMode != "turbo" {
		http.Error(w, "Invalid sync_mode (silent, standard, turbo)", http.StatusBadRequest)
		return
	}

	// Load pending device data
	pendingJSON, _ := s.db.GetConfig(pendingDevicePrefix + deviceID)
	if pendingJSON == "" {
		http.Error(w, "Device not found in pending list", http.StatusNotFound)
		return
	}

	pending := parsePendingEnrollmentMeta(pendingJSON)
	if pending.DeviceID == "" {
		pending.DeviceID = deviceID
	}

	// Create the peer
	enrollment := &EnrollmentRequest{
		DeviceID:   pending.DeviceID,
		UUID:       pending.UUID,
		Hostname:   pending.Hostname,
		Platform:   pending.Platform,
		Version:    pending.Version,
		DeviceType: pending.DeviceType,
		BundleID:   pending.BundleID,
		Tags:       pending.Tags,
		PublicKey:  pending.PublicKey,
	}
	s.createPeerFromEnrollment(enrollment, pending.IP)

	// Store sync mode and display name
	s.db.SetConfig("device_sync_mode_"+deviceID, syncMode)
	if req.DisplayName != "" {
		s.db.SetConfig("device_display_name_"+deviceID, req.DisplayName)
		// Also update the peer's note field for display
		s.db.UpdatePeerFields(deviceID, map[string]string{"note": req.DisplayName})
	}

	// Preserve enrollment-provided tags unless the approving operator supplied
	// an explicit replacement.
	tags := normalizeEnrollmentTags(pending.Tags)
	if operatorTags := normalizeEnrollmentTags(req.Tags); operatorTags != "" {
		tags = operatorTags
		s.db.UpdatePeerFields(deviceID, map[string]string{"tags": tags})
	}

	// Remove from pending and clear any prior rejection lock (#351).
	s.db.DeleteConfig(pendingDevicePrefix + deviceID)
	s.db.DeleteConfig(rejectedDevicePrefix + deviceID)

	actor := getUsernameFromCtx(r)
	s.storeEnrollmentDecision(enrollmentDecision{
		DeviceID:   deviceID,
		UUID:       pending.UUID,
		Hostname:   pending.Hostname,
		Platform:   pending.Platform,
		Version:    pending.Version,
		DeviceType: pending.DeviceType,
		BundleID:   pending.BundleID,
		Tags:       tags,
		IP:         pending.IP,
		Status:     "approved",
		Banned:     false,
		DecidedAt:  timeNowISO(),
		CreatedAt:  pending.CreatedAt,
		Actor:      actor,
	})

	if s.auditLog != nil {
		s.auditLog.Log("device_approved", s.remoteIP(r), actor, map[string]string{
			"device_id": deviceID, "sync_mode": syncMode, "display_name": req.DisplayName, "tags": tags,
		})
	}

	// Emit event for real-time push
	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "device_approved",
			Data: map[string]string{
				"device_id":    deviceID,
				"sync_mode":    syncMode,
				"display_name": req.DisplayName,
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"device_id": deviceID,
		"sync_mode": syncMode,
	})
}

// handleRejectDevice rejects a pending enrollment request.
// POST /api/enrollment/reject/{id}
func (s *Server) handleRejectDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	if deviceID == "" {
		http.Error(w, "Device ID required", http.StatusBadRequest)
		return
	}

	var req struct {
		Ban bool `json:"ban"` // also ban the device so it cannot retry
	}
	// Body is optional; ignore decode errors (empty body = no ban).
	_ = json.NewDecoder(r.Body).Decode(&req)

	pendingJSON, _ := s.db.GetConfig(pendingDevicePrefix + deviceID)
	pending := parsePendingEnrollmentMeta(pendingJSON)
	if pending.DeviceID == "" {
		pending.DeviceID = deviceID
	}

	// Remove from pending
	s.db.DeleteConfig(pendingDevicePrefix + deviceID)

	// Store rejection marker with metadata (status poll + history UI).
	rejectedPayload, _ := json.Marshal(map[string]interface{}{
		"rejected":    true,
		"device_id":   deviceID,
		"uuid":        pending.UUID,
		"hostname":    pending.Hostname,
		"platform":    pending.Platform,
		"version":     pending.Version,
		"device_type": pending.DeviceType,
		"bundle_id":   pending.BundleID,
		"tags":        pending.Tags,
		"ip":          pending.IP,
		"created_at":  pending.CreatedAt,
		"banned":      req.Ban,
		"decided_at":  timeNowISO(),
	})
	s.db.SetConfig(rejectedDevicePrefix+deviceID, string(rejectedPayload))

	// Optionally ban so Devices → Banned shows the device (#351).
	// Pending enrollments often have no peers row yet — create one first.
	if req.Ban {
		existing, err := s.db.GetPeer(deviceID)
		if err != nil {
			log.Printf("[API] handleRejectDevice: GetPeer %s: %v", deviceID, err)
		}
		if existing == nil {
			s.createPeerFromEnrollment(&EnrollmentRequest{
				DeviceID:   pending.DeviceID,
				UUID:       pending.UUID,
				Hostname:   pending.Hostname,
				Platform:   pending.Platform,
				Version:    pending.Version,
				DeviceType: pending.DeviceType,
				BundleID:   pending.BundleID,
				Tags:       pending.Tags,
				PublicKey:  pending.PublicKey,
			}, pending.IP)
		}
		if err := s.db.BanPeer(deviceID, enrollmentRejectBanReason); err != nil {
			log.Printf("[API] handleRejectDevice: failed to ban %s: %v", deviceID, err)
		} else {
			if s.peers != nil {
				s.peers.Remove(deviceID)
			}
			_ = s.db.UpdatePeerStatus(deviceID, "OFFLINE", "")
		}
	}

	actor := getUsernameFromCtx(r)
	s.storeEnrollmentDecision(enrollmentDecision{
		DeviceID:   deviceID,
		UUID:       pending.UUID,
		Hostname:   pending.Hostname,
		Platform:   pending.Platform,
		Version:    pending.Version,
		DeviceType: pending.DeviceType,
		BundleID:   pending.BundleID,
		Tags:       pending.Tags,
		IP:         pending.IP,
		Status:     "rejected",
		Banned:     req.Ban,
		DecidedAt:  timeNowISO(),
		CreatedAt:  pending.CreatedAt,
		Actor:      actor,
	})

	if s.auditLog != nil {
		s.auditLog.Log("device_rejected", s.remoteIP(r), actor, map[string]string{
			"device_id": deviceID,
			"banned":    strconv.FormatBool(req.Ban),
		})
	}

	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "device_rejected",
			Data: map[string]string{
				"device_id": deviceID,
				"banned":    strconv.FormatBool(req.Ban),
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "banned": req.Ban})
}

// handleClearEnrollmentRejection removes the rejection lock so the device can
// re-enter the pending queue. Also unbans when the ban reason is enrollment reject.
// POST /api/enrollment/clear-rejection/{id}
func (s *Server) handleClearEnrollmentRejection(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	if deviceID == "" {
		http.Error(w, "Device ID required", http.StatusBadRequest)
		return
	}

	rejected, _ := s.db.GetConfig(rejectedDevicePrefix + deviceID)
	decisionRaw, _ := s.db.GetConfig(enrollmentDecisionPrefix + deviceID)
	if rejected == "" && decisionRaw == "" {
		http.Error(w, "No enrollment rejection found for device", http.StatusNotFound)
		return
	}

	unbanned := false
	if peerRow, err := s.db.GetPeer(deviceID); err == nil && peerRow != nil && peerRow.Banned {
		if peerRow.BanReason == enrollmentRejectBanReason {
			if err := s.db.UnbanPeer(deviceID); err != nil {
				log.Printf("[API] handleClearEnrollmentRejection: UnbanPeer %s: %v", deviceID, err)
			} else {
				unbanned = true
				if s.peers != nil {
					if entry := s.peers.Get(deviceID); entry != nil {
						entry.Banned = false
					}
				}
			}
		}
	}

	s.clearEnrollmentRejectionState(deviceID)

	actor := getUsernameFromCtx(r)
	if s.auditLog != nil {
		s.auditLog.Log("enrollment_rejection_cleared", s.remoteIP(r), actor, map[string]string{
			"device_id": deviceID,
			"unbanned":  strconv.FormatBool(unbanned),
		})
	}

	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "enrollment_rejection_cleared",
			Data: map[string]string{
				"device_id": deviceID,
				"unbanned":  strconv.FormatBool(unbanned),
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"device_id": deviceID,
		"unbanned":  unbanned,
	})
}

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

func (s *Server) buildEnrollmentResponse(status, deviceID, syncMode, displayName string) EnrollmentResponse {
	resp := EnrollmentResponse{
		Status:       status,
		DeviceID:     deviceID,
		ServerTime:   timeNowUnixMilli(),
		SyncMode:     syncMode,
		DisplayName:  displayName,
		HeartbeatSec: 15,
	}

	// Inline branding
	branding := &BrandingConfig{
		CompanyName:    "BetterDesk",
		AccentColor:    "#4f6ef7",
		SupportContact: "",
		SyncModes:      defaultSyncModes,
	}
	if v, _ := s.db.GetConfig("branding_company_name"); v != "" {
		branding.CompanyName = v
	}
	if v, _ := s.db.GetConfig("branding_accent_color"); v != "" {
		branding.AccentColor = v
	}
	if v, _ := s.db.GetConfig("branding_support_contact"); v != "" {
		branding.SupportContact = v
	}
	if v, _ := s.db.GetConfig("branding_colors"); v != "" {
		var colors map[string]string
		if json.Unmarshal([]byte(v), &colors) == nil {
			branding.Colors = colors
		}
	}
	resp.Branding = branding

	// Server public key
	if s.keyPair != nil {
		resp.ServerKey = s.keyPair.PublicKeyBase64()
	}

	return resp
}

func (s *Server) issueEnrollmentDeviceToken(deviceID string) (string, error) {
	plainToken, err := generateSecureToken(32)
	if err != nil {
		return "", err
	}

	token := &db.DeviceToken{
		Token:     plainToken,
		TokenHash: hashToken(plainToken),
		Name:      "Auto-" + deviceID,
		PeerID:    deviceID,
		Status:    db.TokenStatusActive,
		MaxUses:   0,
		UseCount:  0,
		CreatedBy: "system",
		Note:      "Auto-issued during device enrollment",
	}

	if err := s.db.CreateDeviceToken(token); err != nil {
		return "", err
	}

	return plainToken, nil
}

func (s *Server) createPeerFromEnrollment(req *EnrollmentRequest, clientIP string) {
	devType := strings.TrimSpace(req.DeviceType)
	if devType == "" {
		devType = "betterdesk"
	}
	tags := normalizeEnrollmentTags(req.Tags)

	s.db.UpsertPeer(&db.Peer{
		ID:         req.DeviceID,
		UUID:       req.UUID,
		IP:         clientIP,
		Hostname:   req.Hostname,
		OS:         req.Platform,
		Version:    req.Version,
		DeviceType: devType,
		Tags:       tags,
		Status:     "ONLINE",
	})

	// Update sysinfo fields separately (handles non-empty check)
	if req.Hostname != "" || req.Platform != "" || req.Version != "" {
		s.db.UpdatePeerSysinfo(req.DeviceID, req.Hostname, req.Platform, req.Version)
	}

	// Persist metadata via UpdatePeerFields so both SQLite and PostgreSQL
	// retain it when the peer row already existed.
	fields := map[string]string{"device_type": devType}
	if tags != "" {
		fields["tags"] = tags
	}
	s.db.UpdatePeerFields(req.DeviceID, fields)

	if bundleID := normalizeEnrollmentBundleID(req.BundleID); bundleID != "" {
		if err := s.db.SetConfig(deviceBundleIDPrefix+req.DeviceID, bundleID); err != nil {
			log.Printf("[API] Failed to persist bundle ID for %s: %v", req.DeviceID, err)
		}
	}

	if req.PublicKey != "" {
		if err := s.storeBdMgmtPublicKey(req.DeviceID, req.PublicKey); err != nil {
			log.Printf("[API] Failed to persist enrollment public key for %s: %v", req.DeviceID, err)
		}
	}
}

// pendingDeviceInfo is also returned to the approval UI. It intentionally
// mirrors pendingEnrollmentMeta so UUID, device type, tags, bundle ID, and
// public-key binding survive the pending → approved transition.
type pendingDeviceInfo = pendingEnrollmentMeta

const deviceBundleIDPrefix = "device_bundle_id_"

func normalizeEnrollmentBundleID(raw string) string {
	bundleID := strings.TrimSpace(raw)
	if len(bundleID) > 128 {
		return bundleID[:128]
	}
	return bundleID
}

// storePendingDevice keeps the first identity submission immutable. Otherwise
// a later unauthenticated retry could replace the public key used to recover a
// token after operator approval.
func (s *Server) storePendingDevice(req *EnrollmentRequest, clientIP string) error {
	if raw, err := s.db.GetConfig(pendingDevicePrefix + req.DeviceID); err == nil && raw != "" {
		existing := parsePendingEnrollmentMeta(raw)
		if existing.DeviceID == "" {
			existing.DeviceID = req.DeviceID
		}
		if existing.UUID != "" && req.UUID != "" && existing.UUID != req.UUID {
			return fmt.Errorf("pending device UUID does not match")
		}
		if existing.PublicKey != "" && req.PublicKey != "" {
			incoming, _ := canonicalizeDevicePublicKey(req.PublicKey)
			stored, err := canonicalizeDevicePublicKey(existing.PublicKey)
			if err != nil || incoming != stored {
				return fmt.Errorf("pending device public key does not match")
			}
		}
		return nil
	}

	info := pendingDeviceInfo{
		DeviceID:   req.DeviceID,
		UUID:       req.UUID,
		Hostname:   req.Hostname,
		Platform:   req.Platform,
		Version:    req.Version,
		DeviceType: strings.TrimSpace(req.DeviceType),
		BundleID:   normalizeEnrollmentBundleID(req.BundleID),
		Tags:       normalizeEnrollmentTags(req.Tags),
		PublicKey:  req.PublicKey,
		IP:         clientIP,
		CreatedAt:  timeNowISO(),
	}
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return s.db.SetConfig(pendingDevicePrefix+req.DeviceID, string(data))
}

func (s *Server) listPendingDevices() []pendingDeviceInfo {
	// This is a pragmatic approach using server_config.
	// For a production system with thousands of pending devices,
	// a dedicated table would be more efficient.
	var result []pendingDeviceInfo

	configs, err := s.db.ListConfigByPrefix(pendingDevicePrefix)
	if err != nil {
		log.Printf("[API] listPendingDevices: %v", err)
		return result
	}

	for _, cfg := range configs {
		var info pendingDeviceInfo
		if json.Unmarshal([]byte(cfg.Value), &info) == nil {
			result = append(result, info)
		}
	}
	return result
}

func timeNowUnixMilli() int64 {
	return time.Now().UnixMilli()
}

func timeNowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// normalizeEnrollmentTags cleans a comma-separated tag list: trims whitespace,
// drops empty entries and de-duplicates while preserving order.
func normalizeEnrollmentTags(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	seen := make(map[string]struct{})
	var out []string
	for _, part := range strings.Split(raw, ",") {
		t := strings.TrimSpace(part)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return strings.Join(out, ",")
}

// handleDeviceSelfAccessPolicy lets an enrolled device publish its local
// access policy. The password itself never leaves the Support Agent: the
// server keeps only a non-verifier marker for UI/audit status.
// POST /api/devices/self/access-policy
func (s *Server) handleDeviceSelfAccessPolicy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID          string `json:"device_id"`
		DeviceToken       string `json:"device_token"`
		Password          string `json:"password,omitempty"` // rejected legacy field
		PasswordSet       bool   `json:"password_set"`
		UnattendedEnabled bool   `json:"unattended_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if body.DeviceID == "" || body.DeviceToken == "" {
		http.Error(w, "device_id and device_token required", http.StatusBadRequest)
		return
	}

	if !s.hasBoundActiveDeviceToken(body.DeviceID, body.DeviceToken) {
		http.Error(w, "invalid device token", http.StatusForbidden)
		return
	}
	if body.Password != "" {
		http.Error(w, "password material must remain on the device", http.StatusBadRequest)
		return
	}

	policy := &db.AccessPolicy{
		PeerID:            body.DeviceID,
		UnattendedEnabled: body.UnattendedEnabled,
		UpdatedBy:         "device:" + body.DeviceID,
	}
	if body.PasswordSet {
		// This marker is intentionally not a password verifier. Relay and CDAP
		// authorization always verify the local secret on the device.
		policy.PasswordHash = "LOCAL_ONLY"
	} else {
		// Clear legacy server-side password hashes after an agent upgrades.
		policy.PasswordHash = "CLEAR"
	}
	if err := s.db.SaveAccessPolicy(policy); err != nil {
		http.Error(w, "failed to save policy", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// suggestAlternateDeviceID returns a collision-safe variant of a peer ID.
func suggestAlternateDeviceID(deviceID string) string {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return ""
	}
	if i := strings.LastIndex(deviceID, "-"); i > 0 {
		suffix := deviceID[i+1:]
		if n, err := strconv.Atoi(suffix); err == nil && n >= 2 {
			return deviceID[:i+1] + strconv.Itoa(n+1)
		}
	}
	return deviceID + "-2"
}
