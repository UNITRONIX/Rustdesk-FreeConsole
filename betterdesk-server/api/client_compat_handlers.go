package api

import (
	"net/http"

	"github.com/unitronix/betterdesk-server/db"
)

// ── RustDesk client compatibility shims ───────────────────────────────
// These endpoints round out the API surface so the RustDesk desktop client
// (which now talks to the Go server on the consolidated client-API port,
// 21121 by default) receives the same responses it previously got from the
// Node.js console. They mirror the shapes in
// web-nodejs/routes/rustdesk-api.routes.js for behavioural parity.

// handleClientSoftware answers the client's software-update probe.
// GET /api/software — public, returns an empty object (no managed updates).
func (s *Server) handleClientSoftware(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleClientSoftwareDownloadLink answers the client's download-link probe.
// GET /api/software/client-download-link — public, returns an empty object.
func (s *Server) handleClientSoftwareDownloadLink(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{})
}

// handleClientUserGroup returns the caller's user-group info in the singular
// {data:{name,guid,groups:[...]}} envelope the Flutter client expects.
// GET /api/user/group — requires authentication (enforced by authMiddleware).
func (s *Server) handleClientUserGroup(w http.ResponseWriter, r *http.Request) {
	groups, err := s.db.ListUserGroups()
	if err != nil || len(groups) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"data": map[string]any{"name": "Default", "guid": "default"},
		})
		return
	}
	out := make([]map[string]any, 0, len(groups))
	for _, g := range groups {
		out = append(out, map[string]any{
			"name":    g.Name,
			"guid":    g.GUID,
			"note":    g.Note,
			"team_id": g.TeamID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"name":   groups[0].Name,
			"guid":   groups[0].GUID,
			"groups": out,
		},
	})
}

// handleClientAuditSummary returns a combined recent-audit snapshot used by the
// RustDesk client's audit view and the panel audit widgets.
// GET /api/audit — requires the audit.view permission.
func (s *Server) handleClientAuditSummary(w http.ResponseWriter, r *http.Request) {
	f := db.AuditFilter{Limit: 50}
	conns, _ := s.db.ListAuditConnections(f)
	files, _ := s.db.ListAuditFiles(f)
	alarms, _ := s.db.ListAuditAlarms(f)
	if conns == nil {
		conns = []*db.AuditConnection{}
	}
	if files == nil {
		files = []*db.AuditFile{}
	}
	if alarms == nil {
		alarms = []*db.AuditAlarm{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"connections": conns,
			"files":       files,
			"alarms":      alarms,
		},
	})
}
