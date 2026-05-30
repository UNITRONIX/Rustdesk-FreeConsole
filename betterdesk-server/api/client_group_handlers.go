package api

import (
	"encoding/json"
	"net/http"

	"github.com/unitronix/betterdesk-server/db"
)

// ── User Groups ───────────────────────────────────────────────────────

// handleUserGroupsGet lists user groups. Auth enforced by route wrapper.
// Role "pro" sees an empty list (matches the Node.js console behaviour).
func (s *Server) handleUserGroupsGet(w http.ResponseWriter, r *http.Request) {
	if getRoleFromCtx(r) == "pro" {
		writeJSON(w, http.StatusOK, map[string]any{"data": []*db.UserGroup{}, "total": 0})
		return
	}
	rows, err := s.db.ListUserGroups()
	if err != nil {
		writeInternalError(w, err, "ListUserGroups")
		return
	}
	if rows == nil {
		rows = []*db.UserGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows, "total": len(rows)})
}

// handleUserGroupsPost creates a user group. Auth enforced by route wrapper.
func (s *Server) handleUserGroupsPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string `json:"name"`
		Note   string `json:"note"`
		TeamID string `json:"team_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Name = truncStr(body.Name, maxHostnameLen)
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	g := &db.UserGroup{Name: body.Name, Note: truncStr(body.Note, 1024), TeamID: truncStr(body.TeamID, maxIDLen)}
	if err := s.db.CreateUserGroup(g); err != nil {
		writeInternalError(w, err, "CreateUserGroup")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// ── Device Groups ─────────────────────────────────────────────────────

// handleDeviceGroupsGet lists device groups. Auth enforced by route wrapper.
func (s *Server) handleDeviceGroupsGet(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.ListDeviceGroups()
	if err != nil {
		writeInternalError(w, err, "ListDeviceGroups")
		return
	}
	if rows == nil {
		rows = []*db.DeviceGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows, "total": len(rows)})
}

// handleDeviceGroupsPost creates a device group. Auth enforced by route wrapper.
func (s *Server) handleDeviceGroupsPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		Note       string `json:"note"`
		TeamID     string `json:"team_id"`
		SourceType string `json:"source_type"`
		TagFilter  string `json:"tag_filter"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Name = truncStr(body.Name, maxHostnameLen)
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	g := &db.DeviceGroup{
		Name:       body.Name,
		Note:       truncStr(body.Note, 1024),
		TeamID:     truncStr(body.TeamID, maxIDLen),
		SourceType: body.SourceType,
		TagFilter:  truncStr(body.TagFilter, 256),
	}
	if err := s.db.CreateDeviceGroup(g); err != nil {
		writeInternalError(w, err, "CreateDeviceGroup")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// ── Strategies ────────────────────────────────────────────────────────

// handleStrategiesGet lists access-control strategies. Auth enforced by route wrapper.
// permissions is emitted as a parsed JSON object for consumer convenience.
func (s *Server) handleStrategiesGet(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.ListStrategies()
	if err != nil {
		writeInternalError(w, err, "ListStrategies")
		return
	}
	data := make([]map[string]any, 0, len(rows))
	for _, st := range rows {
		var perms any
		if st.Permissions == "" || json.Unmarshal([]byte(st.Permissions), &perms) != nil {
			perms = map[string]any{}
		}
		data = append(data, map[string]any{
			"id":                st.ID,
			"guid":              st.GUID,
			"name":              st.Name,
			"user_group_guid":   st.UserGroupGUID,
			"device_group_guid": st.DeviceGroupGUID,
			"enabled":           st.Enabled,
			"permissions":       perms,
			"created_at":        st.CreatedAt,
			"updated_at":        st.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": data, "total": len(data)})
}

// handleStrategiesPost creates a strategy. Auth enforced by route wrapper.
func (s *Server) handleStrategiesPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name            string          `json:"name"`
		UserGroupGUID   string          `json:"user_group_guid"`
		DeviceGroupGUID string          `json:"device_group_guid"`
		Enabled         *bool           `json:"enabled"`
		Permissions     json.RawMessage `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Name = truncStr(body.Name, maxHostnameLen)
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	perms := "{}"
	if len(body.Permissions) > 0 && string(body.Permissions) != "null" {
		perms = string(body.Permissions)
	}
	st := &db.Strategy{
		Name:            body.Name,
		UserGroupGUID:   truncStr(body.UserGroupGUID, maxIDLen),
		DeviceGroupGUID: truncStr(body.DeviceGroupGUID, maxIDLen),
		Enabled:         enabled,
		Permissions:     perms,
	}
	if err := s.db.CreateStrategy(st); err != nil {
		writeInternalError(w, err, "CreateStrategy")
		return
	}
	writeJSON(w, http.StatusOK, st)
}
