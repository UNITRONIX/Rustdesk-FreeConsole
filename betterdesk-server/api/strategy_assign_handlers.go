package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
)

func strategyPayload(st *db.Strategy, summary *db.StrategyAssignmentSummary) map[string]any {
	var perms any
	if st.Permissions == "" || json.Unmarshal([]byte(st.Permissions), &perms) != nil {
		perms = map[string]any{}
	}
	out := map[string]any{
		"id":                st.ID,
		"guid":              st.GUID,
		"name":              st.Name,
		"user_group_guid":   st.UserGroupGUID,
		"device_group_guid": st.DeviceGroupGUID,
		"enabled":           st.Enabled,
		"permissions":       perms,
		"created_at":        st.CreatedAt,
		"updated_at":        st.UpdatedAt,
	}
	if summary != nil {
		out["peer_count"] = summary.PeerCount
		out["user_count"] = summary.UserCount
		out["device_group_count"] = summary.DeviceGroupCount
		out["peers"] = summary.Peers
		out["users"] = summary.Users
		out["groups"] = summary.Groups
	}
	return out
}

// handleStrategiesGetByGUID returns one strategy with direct assignment summary.
func (s *Server) handleStrategiesGetByGUID(w http.ResponseWriter, r *http.Request) {
	guid := truncStr(r.PathValue("guid"), maxIDLen)
	if guid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "guid is required"})
		return
	}
	st, err := s.db.GetStrategy(guid)
	if err != nil {
		writeInternalError(w, err, "GetStrategy")
		return
	}
	if st == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Strategy not found"})
		return
	}
	summary, err := s.db.GetStrategyAssignmentSummary(guid)
	if err != nil {
		writeInternalError(w, err, "GetStrategyAssignmentSummary")
		return
	}
	writeJSON(w, http.StatusOK, strategyPayload(st, summary))
}

// handleStrategiesAssign assigns or unassigns a strategy to peers/users/device groups.
// POST /api/strategies/assign  { strategy?, peers[], users[], groups[] }
func (s *Server) handleStrategiesAssign(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Strategy string   `json:"strategy"`
		Peers    []string `json:"peers"`
		Users    []string `json:"users"`
		Groups   []string `json:"groups"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	strategyGUID := truncStr(body.Strategy, maxIDLen)
	if len(body.Peers) == 0 && len(body.Users) == 0 && len(body.Groups) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one target is required"})
		return
	}

	peerKeys, err := resolveStrategyRefs(s.db.ResolvePeerAssignmentKey, body.Peers, "peer")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	userKeys, err := resolveStrategyRefs(s.db.ResolveUserAssignmentKey, body.Users, "user")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	groupKeys, err := resolveStrategyRefs(s.db.ResolveDeviceGroupAssignmentKey, body.Groups, "device group")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if err := s.db.AssignStrategy(strategyGUID, peerKeys, userKeys, groupKeys); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeInternalError(w, err, "AssignStrategy")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func resolveStrategyRefs(resolver func(string) (string, error), refs []string, label string) ([]string, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		key, err := resolver(ref)
		if err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, nil
}

// handleStrategiesStatus toggles strategy enabled flag. Body is raw JSON true/false.
func (s *Server) handleStrategiesStatus(w http.ResponseWriter, r *http.Request) {
	guid := truncStr(r.PathValue("guid"), maxIDLen)
	if guid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "guid is required"})
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 64))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	enabled := strings.TrimSpace(string(raw)) == "true"
	if err := s.db.SetStrategyEnabled(guid, enabled); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeInternalError(w, err, "SetStrategyEnabled")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleProDevicesList returns {total,data:[{id,guid}]} for RustDesk Pro admin scripts.
func (s *Server) handleProDevicesList(w http.ResponseWriter, r *http.Request) {
	idFilter := truncStr(r.URL.Query().Get("id"), maxIDLen)
	limit := 50
	if v := r.URL.Query().Get("pageSize"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("current"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 1 {
			offset = (n - 1) * limit
		}
	}

	rows, total, err := s.db.ListProDeviceRefs(idFilter, limit, offset)
	if err != nil {
		writeInternalError(w, err, "ListProDeviceRefs")
		return
	}
	data := make([]map[string]string, 0, len(rows))
	for _, row := range rows {
		data = append(data, map[string]string{"id": row.ID, "guid": row.GUID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "data": data})
}

// handleProDeviceAssign assigns metadata to a device (strategy_name, note, etc.).
func (s *Server) handleProDeviceAssign(w http.ResponseWriter, r *http.Request) {
	guid := truncStr(r.PathValue("guid"), maxIDLen)
	if guid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "guid is required"})
		return
	}

	var body struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Type = strings.TrimSpace(body.Type)
	body.Value = strings.TrimSpace(body.Value)

	peerKey, err := s.db.ResolvePeerAssignmentKey(guid)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "device not found"})
		return
	}

	switch body.Type {
	case "strategy_name":
		if body.Value == "" {
			if err := s.db.AssignStrategy("", []string{peerKey}, nil, nil); err != nil {
				writeInternalError(w, err, "AssignStrategy")
				return
			}
			break
		}
		strategyGUID := ""
		if len(body.Value) == 36 && strings.Count(body.Value, "-") == 4 {
			if st, err := s.db.GetStrategy(body.Value); err == nil && st != nil {
				strategyGUID = st.GUID
			}
		}
		if strategyGUID == "" {
			all, err := s.db.ListStrategies()
			if err != nil {
				writeInternalError(w, err, "ListStrategies")
				return
			}
			for _, candidate := range all {
				if candidate.Name == body.Value {
					strategyGUID = candidate.GUID
					break
				}
			}
		}
		if strategyGUID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "strategy not found"})
			return
		}
		if err := s.db.AssignStrategy(strategyGUID, []string{peerKey}, nil, nil); err != nil {
			writeInternalError(w, err, "AssignStrategy")
			return
		}
	case "note":
		peerID, err := s.db.GetPeerIDByGUID(peerKey)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "device not found"})
			return
		}
		if err := s.db.UpdatePeerFields(peerID, map[string]string{"note": truncStr(body.Value, 1024)}); err != nil {
			writeInternalError(w, err, "UpdatePeerFields")
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported assign type"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
