package api

import (
	"net/http"

	"github.com/unitronix/betterdesk-server/timesync"
)

// SetTimeSyncService attaches the clock monitor.
func (s *Server) SetTimeSyncService(ts *timesync.Service) {
	s.timeSync = ts
}

// GET /api/timesync/status
func (s *Server) handleTimeSyncStatus(w http.ResponseWriter, r *http.Request) {
	if s.timeSync == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "timesync not configured"})
		return
	}
	writeJSON(w, http.StatusOK, s.timeSync.GetStatus())
}

// POST /api/timesync/check
func (s *Server) handleTimeSyncCheck(w http.ResponseWriter, r *http.Request) {
	if s.timeSync == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "timesync not configured"})
		return
	}
	st := s.timeSync.CheckNow()
	writeJSON(w, http.StatusOK, st)
}
