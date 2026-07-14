package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

// Validation limits and value sets mirror the Node.js RustDesk client API
// (web-nodejs/routes/rustdesk-api.routes.js) for behavioural parity.
const (
	maxIDLen       = 32
	maxHostnameLen = 256
	maxFilesPerOp  = 100
)

var (
	connTypes  = map[int]bool{0: true, 1: true, 2: true, 3: true, 4: true}
	alarmTypes = map[int]bool{0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true}
)

// truncStr trims a string to a maximum length (rune-safe enough for ASCII IDs).
func truncStr(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

// coerceStr converts arbitrary JSON scalars (string or number) to a string,
// matching the Node.js `String(value)` coercion used for host_id/peer_id.
func coerceStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		// JSON numbers decode to float64; render without trailing ".0" for ints.
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

func coerceInt(v any) int {
	switch value := v.(type) {
	case float64:
		return int(value)
	case string:
		n, _ := strconv.Atoi(value)
		return n
	case json.Number:
		n, _ := strconv.Atoi(value.String())
		return n
	default:
		return 0
	}
}

func firstBodyString(body map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(coerceStr(body[key])); value != "" {
			return value
		}
	}
	return ""
}

// RustDesk 1.4.4+ sends peer as [controller_id, controller_display_name].
// Keep accepting the older flat aliases used by the consolidated Node API.
func auditPeer(body map[string]any) (string, string) {
	peerID := firstBodyString(body, "peer_id")
	peerName := firstBodyString(body, "peer_name")
	if peer, ok := body["peer"].([]any); ok {
		if len(peer) > 0 {
			peerID = coerceStr(peer[0])
		}
		if len(peer) > 1 {
			peerName = coerceStr(peer[1])
		}
	}
	return peerID, peerName
}

// canonicalDeviceUUID accepts the UUID representations used by RustDesk's
// different storage and audit paths. The peer table can contain the ASCII
// UUID hex-encoded, while the official client audit endpoint sends the same
// ASCII UUID base64-encoded. Only values that decode to a real 128-bit UUID
// are accepted, so this does not weaken the device identity check.
func canonicalDeviceUUID(value string) (string, bool) {
	parse := func(candidate string) (string, bool) {
		candidate = strings.TrimSpace(strings.Trim(candidate, "{}"))
		compact := strings.ReplaceAll(strings.ToLower(candidate), "-", "")
		if len(compact) != 32 {
			return "", false
		}
		if _, err := hex.DecodeString(compact); err != nil {
			return "", false
		}
		return compact, true
	}
	if canonical, ok := parse(value); ok {
		return canonical, true
	}
	if decoded, err := hex.DecodeString(strings.TrimSpace(value)); err == nil {
		if len(decoded) == 16 {
			return hex.EncodeToString(decoded), true
		}
		if canonical, ok := parse(string(decoded)); ok {
			return canonical, true
		}
	}
	for _, encoding := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding,
	} {
		if decoded, err := encoding.DecodeString(strings.TrimSpace(value)); err == nil {
			if len(decoded) == 16 {
				return hex.EncodeToString(decoded), true
			}
			if canonical, ok := parse(string(decoded)); ok {
				return canonical, true
			}
		}
	}
	return "", false
}

func sameDeviceUUID(reported, stored string) bool {
	reported = strings.TrimSpace(reported)
	stored = strings.TrimSpace(stored)
	if reported == stored {
		return true
	}
	reportedCanonical, reportedOK := canonicalDeviceUUID(reported)
	storedCanonical, storedOK := canonicalDeviceUUID(stored)
	return reportedOK && storedOK && reportedCanonical == storedCanonical
}

func nativeRemoteSessionKey(targetID, targetUUID, sessionID, connectionID string, connType int) string {
	if canonical, ok := canonicalDeviceUUID(targetUUID); ok {
		targetUUID = canonical
	}
	// session_id is stable across the authorised and close audit events and is
	// the RustDesk session identity. conn_id is local to one controlled-client
	// connection and is only a fallback for legacy payloads without session_id.
	// Ignoring conn_id when session_id exists also lets an accepted audit event
	// be safely reconciled after an API restart.
	stableID := sessionID
	if stableID == "" || stableID == "0" {
		stableID = connectionID
	}
	identity := strings.Join([]string{targetID, targetUUID, stableID, strconv.Itoa(connType)}, "\x00")
	sum := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("native:%x", sum[:])
}

// queryLimitOffset parses limit/offset query params with sane defaults.
func queryLimitOffset(r *http.Request) (int, int) {
	limit := 100
	offset := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			offset = n
		}
	}
	return limit, offset
}

// ── Audit: Connections ────────────────────────────────────────────────

// handleAuditConnPost records a connection event reported by a RustDesk client.
// Public endpoint (no auth) — matches the Node.js behaviour.
func (s *Server) handleAuditConnPost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	// Official RustDesk uses id/uuid/type/peer/conn_id. The host_* and
	// peer_* aliases are retained for backward compatibility.
	hostID := truncStr(firstBodyString(body, "host_id", "id"), maxIDLen)
	if hostID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	connType := coerceInt(body["conn_type"])
	if _, exists := body["conn_type"]; !exists {
		connType = coerceInt(body["type"])
	}
	if !connTypes[connType] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid conn_type"})
		return
	}
	ip := truncStr(coerceStr(body["ip"]), 64)
	if ip == "" {
		ip = s.remoteIP(r)
	}
	hostUUID := truncStr(firstBodyString(body, "host_uuid", "uuid"), maxHostnameLen)
	peerID, peerName := auditPeer(body)
	peerID = truncStr(peerID, maxIDLen)
	peerName = truncStr(peerName, maxHostnameLen)
	action := strings.ToLower(truncStr(firstBodyString(body, "action"), 32))
	// An authorised RustDesk connection is the second audit event: it has a
	// peer tuple and no action. "new" is only a connection attempt.
	if action == "" && peerID != "" {
		action = "connect"
	} else if action == "" {
		action = "event"
	}
	sessionID := truncStr(firstBodyString(body, "session_id"), 64)
	connectionID := truncStr(firstBodyString(body, "conn_id", "connection_id"), 64)
	rec := &db.AuditConnection{
		HostID:    hostID,
		HostUUID:  hostUUID,
		PeerID:    peerID,
		PeerName:  peerName,
		Action:    action,
		ConnType:  connType,
		SessionID: sessionID,
		IP:        ip,
	}
	if err := s.db.InsertAuditConnection(rec); err != nil {
		writeInternalError(w, err, "InsertAuditConnection")
		return
	}

	// Only non-zero, authorised sessions become work-time records. Validate
	// the target identity before accepting an unauthenticated client audit.
	if sessionID != "" && sessionID != "0" && (action == "connect" || action == "close" || action == "disconnect") {
		peer, peerErr := s.db.GetPeer(hostID)
		if peerErr != nil {
			writeInternalError(w, peerErr, "AuditConnectionPeer")
			return
		}
		if peer == nil || (hostUUID != "" && peer.UUID != "" && !sameDeviceUUID(hostUUID, peer.UUID)) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown device identity"})
			return
		}
		key := nativeRemoteSessionKey(hostID, hostUUID, sessionID, connectionID, connType)
		now := time.Now().UTC()
		if action == "connect" && peerID != "" {
			operator, lookupErr := s.db.FindActiveClientUsernameByDevice(peerID)
			if lookupErr != nil {
				log.Printf("[audit] operator lookup for %s failed: %v", peerID, lookupErr)
			}
			if operator == "" {
				operator = strings.TrimSpace(peerName)
			}
			if operator == "" {
				operator = peerID
			}
			if err := s.db.UpsertRemoteAccessSession(&db.RemoteAccessSession{
				SessionKey: key, TargetID: hostID, TargetUUID: hostUUID,
				OperatorUsername: operator, ControllerID: peerID, ControllerName: peerName,
				ConnectionType: connType, Source: "rustdesk_audit", StartedAt: now, LastSeenAt: now,
			}); err != nil {
				writeInternalError(w, err, "UpsertRemoteAccessSession")
				return
			}
		} else if action == "close" || action == "disconnect" {
			if err := s.db.EndRemoteAccessSession(key, now, action); err != nil {
				writeInternalError(w, err, "EndRemoteAccessSession")
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleAuditConnGet returns connection audit records. Auth enforced by route wrapper.
func (s *Server) handleAuditConnGet(w http.ResponseWriter, r *http.Request) {
	limit, offset := queryLimitOffset(r)
	f := db.AuditFilter{
		HostID: r.URL.Query().Get("host_id"),
		PeerID: r.URL.Query().Get("peer_id"),
		Action: r.URL.Query().Get("action"),
		Limit:  limit,
		Offset: offset,
	}
	rows, err := s.db.ListAuditConnections(f)
	if err != nil {
		writeInternalError(w, err, "ListAuditConnections")
		return
	}
	total, err := s.db.CountAuditConnections(f)
	if err != nil {
		writeInternalError(w, err, "CountAuditConnections")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": emptyIfNilConn(rows), "total": total})
}

// ── Audit: File Transfers ─────────────────────────────────────────────

// handleAuditFilePost records a file-transfer event. Public endpoint.
func (s *Server) handleAuditFilePost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	hostID := truncStr(coerceStr(body["host_id"]), maxIDLen)
	if hostID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host_id is required"})
		return
	}
	direction := 0
	if v, ok := body["direction"].(float64); ok {
		direction = int(v)
	}
	if direction != 0 && direction != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid direction"})
		return
	}
	isFile := 1
	if v, ok := body["is_file"].(float64); ok {
		isFile = int(v)
	}
	numFiles := 0
	if v, ok := body["num_files"].(float64); ok {
		numFiles = int(v)
	}
	if numFiles < 0 || numFiles > 10000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid num_files"})
		return
	}
	filesJSON := "[]"
	if arr, ok := body["files"].([]any); ok {
		if len(arr) > maxFilesPerOp {
			arr = arr[:maxFilesPerOp]
		}
		if b, err := json.Marshal(arr); err == nil {
			filesJSON = string(b)
		}
	}
	ip := truncStr(coerceStr(body["ip"]), 64)
	if ip == "" {
		ip = s.remoteIP(r)
	}
	rec := &db.AuditFile{
		HostID:    hostID,
		HostUUID:  truncStr(coerceStr(body["host_uuid"]), maxIDLen),
		PeerID:    truncStr(coerceStr(body["peer_id"]), maxIDLen),
		Direction: direction,
		Path:      truncStr(coerceStr(body["path"]), 1024),
		IsFile:    isFile,
		NumFiles:  numFiles,
		FilesJSON: filesJSON,
		IP:        ip,
		PeerName:  truncStr(coerceStr(body["peer_name"]), maxHostnameLen),
	}
	if err := s.db.InsertAuditFile(rec); err != nil {
		writeInternalError(w, err, "InsertAuditFile")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleAuditFileGet returns file-transfer audit records. Auth enforced by route wrapper.
func (s *Server) handleAuditFileGet(w http.ResponseWriter, r *http.Request) {
	limit, offset := queryLimitOffset(r)
	f := db.AuditFilter{
		HostID: r.URL.Query().Get("host_id"),
		PeerID: r.URL.Query().Get("peer_id"),
		Limit:  limit,
		Offset: offset,
	}
	rows, err := s.db.ListAuditFiles(f)
	if err != nil {
		writeInternalError(w, err, "ListAuditFiles")
		return
	}
	total, err := s.db.CountAuditFiles(f)
	if err != nil {
		writeInternalError(w, err, "CountAuditFiles")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": emptyIfNilFile(rows), "total": total})
}

// ── Audit: Security Alarms ────────────────────────────────────────────

// handleAuditAlarmPost records a security alarm. Public endpoint.
func (s *Server) handleAuditAlarmPost(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	alarmType := 0
	if v, ok := body["alarm_type"].(float64); ok {
		alarmType = int(v)
	}
	if !alarmTypes[alarmType] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid alarm_type"})
		return
	}
	details := "{}"
	if raw, ok := body["details"]; ok && raw != nil {
		switch t := raw.(type) {
		case string:
			if t != "" {
				details = t
			}
		default:
			if b, err := json.Marshal(t); err == nil {
				details = string(b)
			}
		}
	}
	ip := truncStr(coerceStr(body["ip"]), 64)
	if ip == "" {
		ip = s.remoteIP(r)
	}
	rec := &db.AuditAlarm{
		AlarmType: alarmType,
		AlarmName: truncStr(coerceStr(body["alarm_name"]), 64),
		HostID:    truncStr(coerceStr(body["host_id"]), maxIDLen),
		PeerID:    truncStr(coerceStr(body["peer_id"]), maxIDLen),
		IP:        ip,
		Details:   truncStr(details, 4096),
	}
	if err := s.db.InsertAuditAlarm(rec); err != nil {
		writeInternalError(w, err, "InsertAuditAlarm")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleAuditAlarmGet returns alarm audit records. Auth enforced by route wrapper.
func (s *Server) handleAuditAlarmGet(w http.ResponseWriter, r *http.Request) {
	limit, offset := queryLimitOffset(r)
	f := db.AuditFilter{
		HostID: r.URL.Query().Get("host_id"),
		Limit:  limit,
		Offset: offset,
	}
	if v := r.URL.Query().Get("alarm_type"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.AlarmType = &n
		}
	}
	rows, err := s.db.ListAuditAlarms(f)
	if err != nil {
		writeInternalError(w, err, "ListAuditAlarms")
		return
	}
	total, err := s.db.CountAuditAlarms(f)
	if err != nil {
		writeInternalError(w, err, "CountAuditAlarms")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": emptyIfNilAlarm(rows), "total": total})
}

// ── Server / Peer Keys ────────────────────────────────────────────────

// handleServerKey returns the Rendezvous Server Ed25519 public key (base64).
// Public — the key is safe to expose and clients use it to verify peer identity.
func (s *Server) handleServerKey(w http.ResponseWriter, r *http.Request) {
	key := ""
	if s.keyPair != nil && len(s.keyPair.PublicKey) == 32 {
		key = s.keyPair.PublicKeyBase64()
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key})
}

// handleServerKeyFingerprint returns the SHA-256 fingerprint of the RS public key.
func (s *Server) handleServerKeyFingerprint(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{"fingerprint": "", "algorithm": "SHA-256"}
	if s.keyPair != nil && len(s.keyPair.PublicKey) == 32 {
		sum := sha256.Sum256(s.keyPair.PublicKey)
		parts := make([]string, len(sum))
		for i, b := range sum {
			parts[i] = fmt.Sprintf("%02X", b)
		}
		resp["fingerprint"] = strings.Join(parts, ":")
	}
	writeJSON(w, http.StatusOK, resp)
}

// handlePeerKey returns a peer's public key (base64). Auth enforced by route wrapper.
func (s *Server) handlePeerKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	resp := map[string]string{"id": id, "pk": ""}
	if auth.IsProRole(getRoleFromCtx(r)) {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	peer, err := s.db.GetPeer(id)
	if err != nil {
		writeInternalError(w, err, "GetPeer")
		return
	}
	if peer != nil && len(peer.PK) > 0 {
		resp["pk"] = base64.StdEncoding.EncodeToString(peer.PK)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── Helpers for empty-slice JSON ([] instead of null) ─────────────────

func emptyIfNilConn(v []*db.AuditConnection) []*db.AuditConnection {
	if v == nil {
		return []*db.AuditConnection{}
	}
	return v
}

func emptyIfNilFile(v []*db.AuditFile) []*db.AuditFile {
	if v == nil {
		return []*db.AuditFile{}
	}
	return v
}

func emptyIfNilAlarm(v []*db.AuditAlarm) []*db.AuditAlarm {
	if v == nil {
		return []*db.AuditAlarm{}
	}
	return v
}

// defaultStr returns def when s is empty.
func defaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
