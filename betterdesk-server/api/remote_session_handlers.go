package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/unitronix/betterdesk-server/db"
)

type remoteSessionEventRequest struct {
	Action           string `json:"action"`
	SessionID        string `json:"session_id"`
	DeviceID         string `json:"device_id"`
	OperatorUsername string `json:"operator_username"`
	ConnectionType   int    `json:"connection_type"`
	Reason           string `json:"reason"`
}

// handleRemoteSessionEvent records authenticated web-console sessions. The
// browser calls the Node console, which supplies its authenticated username;
// the internal API key is the trust boundary between Node and this handler.
func (s *Server) handleRemoteSessionEvent(w http.ResponseWriter, r *http.Request) {
	var request remoteSessionEventRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session event"})
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.DeviceID = truncStr(strings.TrimSpace(request.DeviceID), maxIDLen)
	request.OperatorUsername = truncStr(strings.TrimSpace(request.OperatorUsername), maxHostnameLen)
	request.Reason = truncStr(strings.TrimSpace(request.Reason), 64)
	if _, err := uuid.Parse(request.SessionID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session_id"})
		return
	}
	if request.Action != "start" && request.Action != "heartbeat" && request.Action != "end" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid action"})
		return
	}
	if !connTypes[request.ConnectionType] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connection_type"})
		return
	}

	authenticatedAs := getUsernameFromCtx(r)
	if !strings.HasPrefix(authenticatedAs, "apikey:") || request.OperatorUsername == "" {
		request.OperatorUsername = authenticatedAs
	}
	if request.OperatorUsername == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "operator is required"})
		return
	}

	key := "web:" + request.SessionID
	now := time.Now().UTC()
	switch request.Action {
	case "start":
		if request.DeviceID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device_id is required"})
			return
		}
		if !s.peerOrgScopeCheck(w, r, request.DeviceID) {
			return
		}
		peer, err := s.db.GetPeer(request.DeviceID)
		if err != nil {
			writeInternalError(w, err, "RemoteSessionPeer")
			return
		}
		if peer == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "device not found"})
			return
		}
		if err := s.db.UpsertRemoteAccessSession(&db.RemoteAccessSession{
			SessionKey: key, TargetID: peer.ID, TargetUUID: peer.UUID,
			OperatorUsername: request.OperatorUsername,
			ControllerID:     "web-console", ControllerName: request.OperatorUsername,
			ConnectionType: request.ConnectionType, Source: "web_console",
			StartedAt: now, LastSeenAt: now,
		}); err != nil {
			writeInternalError(w, err, "UpsertRemoteAccessSession")
			return
		}
	case "heartbeat":
		if err := s.db.TouchRemoteAccessSession(key, now); err != nil {
			writeInternalError(w, err, "TouchRemoteAccessSession")
			return
		}
	case "end":
		reason := request.Reason
		if reason == "" {
			reason = "web_disconnect"
		}
		if err := s.db.EndRemoteAccessSession(key, now, reason); err != nil {
			writeInternalError(w, err, "EndRemoteAccessSession")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "recorded_at": now})
}
