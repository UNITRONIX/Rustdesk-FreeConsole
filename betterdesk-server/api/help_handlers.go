// Help request REST API handlers — operator-facing read & status updates.
//
// Help requests are raised by agent devices via CDAP (handleHelpRequest) and
// persisted by the Go server. The Node.js panel reads them through these
// endpoints; it never stores help-request state itself.
//
// Endpoints:
//   GET  /api/help/requests                  — list (filter by status, device)
//   GET  /api/help/requests/{id}             — single request
//   POST /api/help/requests/{id}/acknowledge — operator picks it up
//   POST /api/help/requests/{id}/resolve     — operator closes it

package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

// handleListHelpRequests returns help requests, scoped to the caller's org.
// GET /api/help/requests?status=pending&device_id=...&limit=100
func (s *Server) handleListHelpRequests(w http.ResponseWriter, r *http.Request) {
	filter := db.HelpRequestFilter{
		Status:   r.URL.Query().Get("status"),
		DeviceID: r.URL.Query().Get("device_id"),
		// Org-scoping: org users only see their org's requests. Global users
		// (empty org_id) see everything.
		OrgID: getOrgIDFromCtx(r),
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			filter.Limit = n
		}
	}

	reqs, err := s.db.ListHelpRequests(filter)
	if err != nil {
		log.Printf("[help] ListHelpRequests error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if reqs == nil {
		reqs = []*db.HelpRequest{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"requests": reqs})
}

// handleCreateHelpRequest creates a help request on behalf of a device.
// POST /api/help/requests   Body: { device_id, hostname, message }
//
// Modern agents raise help requests over CDAP (handleHelpRequest). This REST
// endpoint exists so the Node.js panel can proxy legacy desktop clients that
// still POST to the panel. It is gated by chat.access permission (the panel
// authenticates with its API key), not exposed to anonymous callers.
func (s *Server) handleCreateHelpRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID string `json:"device_id"`
		Hostname string `json:"hostname"`
		Message  string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	body.DeviceID = strings.TrimSpace(body.DeviceID)
	if body.DeviceID == "" {
		http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
		return
	}
	if len(body.Message) > 2048 {
		body.Message = body.Message[:2048]
	}

	orgID, _ := s.db.GetDeviceOrgID(body.DeviceID)
	req := &db.HelpRequest{
		DeviceID: body.DeviceID,
		Hostname: body.Hostname,
		OrgID:    orgID,
		Message:  body.Message,
		Status:   db.HelpStatusPending,
	}
	id, err := s.db.CreateHelpRequest(req)
	if err != nil {
		log.Printf("[help] CreateHelpRequest error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	req.ID = id

	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "help_request",
			Data: map[string]string{
				"id":        strconv.FormatInt(id, 10),
				"device_id": req.DeviceID,
				"hostname":  req.Hostname,
				"org_id":    req.OrgID,
				"message":   req.Message,
				"status":    req.Status,
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(req)
}

// handleGetHelpRequest returns a single help request by ID.
// GET /api/help/requests/{id}
func (s *Server) handleGetHelpRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := parseHelpRequestID(w, r, "/api/help/requests/")
	if !ok {
		return
	}

	req, err := s.db.GetHelpRequest(id)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if !helpRequestInScope(r, req) {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(req)
}

// handleAcknowledgeHelpRequest marks a request as acknowledged by the operator.
// POST /api/help/requests/{id}/acknowledge
func (s *Server) handleAcknowledgeHelpRequest(w http.ResponseWriter, r *http.Request) {
	s.updateHelpRequestStatus(w, r, db.HelpStatusAcknowledged)
}

// handleResolveHelpRequest marks a request as resolved by the operator.
// POST /api/help/requests/{id}/resolve
func (s *Server) handleResolveHelpRequest(w http.ResponseWriter, r *http.Request) {
	s.updateHelpRequestStatus(w, r, db.HelpStatusResolved)
}

// updateHelpRequestStatus is the shared body for acknowledge/resolve.
func (s *Server) updateHelpRequestStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, ok := parseHelpRequestID(w, r, "/api/help/requests/")
	if !ok {
		return
	}

	req, err := s.db.GetHelpRequest(id)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if !helpRequestInScope(r, req) {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	operator := getUsernameFromCtx(r)
	if err := s.db.UpdateHelpRequestStatus(id, status, operator); err != nil {
		log.Printf("[help] UpdateHelpRequestStatus error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "help_request",
			Data: map[string]string{
				"id":         strconv.FormatInt(id, 10),
				"device_id":  req.DeviceID,
				"status":     status,
				"handled_by": operator,
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"id":         id,
		"status":     status,
		"handled_by": operator,
	})
}

// parseHelpRequestID extracts a numeric ID from a path with the given prefix.
func parseHelpRequestID(w http.ResponseWriter, r *http.Request, prefix string) (int64, bool) {
	idStr := strings.TrimPrefix(r.URL.Path, prefix)
	// Strip any trailing action suffix (e.g. "12/resolve").
	if i := strings.IndexByte(idStr, '/'); i >= 0 {
		idStr = idStr[:i]
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// helpRequestInScope returns true if the caller may access the given request.
// Global users (empty org) may access anything; org users only their org.
func helpRequestInScope(r *http.Request, req *db.HelpRequest) bool {
	orgID := getOrgIDFromCtx(r)
	if orgID == "" {
		return true
	}
	return req.OrgID == orgID
}
