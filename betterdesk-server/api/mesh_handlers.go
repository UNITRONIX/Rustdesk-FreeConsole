package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/meshcentral"
)

func (s *Server) handleMeshServerID(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh compatibility disabled"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"server_id": s.meshGw.ServerID(),
	})
}

func (s *Server) handleMeshStatus(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"enabled": false,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"enabled":       true,
		"core_version":  s.cfg.MeshCoreVersion,
		"agents_online": s.meshGw.ActiveAgentCount(),
		"server_id":     s.meshGw.ServerID(),
	})
}

func (s *Server) handleMeshGroupsList(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"groups": s.meshGw.ListGroups(),
	})
}

func (s *Server) handleMeshGroupsSave(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	var body struct {
		Groups []meshcentral.MeshGroup `json:"groups"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.meshGw.SaveGroups(body.Groups); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMeshDownloadMSH(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	meshName := r.URL.Query().Get("name")
	if meshName == "" {
		meshName = "BetterDesk Mesh"
	}
	meshID := r.URL.Query().Get("mesh_id")
	if meshID == "" {
		meshID = "EDBE1BE377EFC5B6D11DE0D50FED96017ADFAD0"
	}
	serverURL := r.URL.Query().Get("mesh_server")
	if serverURL == "" {
		host := r.Host
		if idx := strings.Index(host, ":"); idx > 0 {
			host = host[:idx]
		}
		serverURL = "wss://" + host + "/agent.ashx"
	}
	content := s.meshGw.BuildMSH(meshName, meshID, serverURL)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\"meshagents.msh\"")
	w.Write([]byte(content))
}

func (s *Server) handleMeshDesktopTunnel(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	viewOnly := false
	shareToken := strings.TrimSpace(r.URL.Query().Get("mesh_share"))
	if shareToken != "" {
		grant, err := s.meshGw.ValidateShareGrant(shareToken, peerID)
		if err != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
			return
		}
		viewOnly = grant.ViewOnly
		if grant.CreatedBy != "" {
			username = grant.CreatedBy
		}
	}
	record := r.URL.Query().Get("record") == "1" || strings.EqualFold(r.URL.Query().Get("record"), "true")
	relayBase := r.URL.Query().Get("relay_base")
	if relayBase == "" {
		relayBase = "/"
	}
	if !strings.HasSuffix(relayBase, "/") {
		relayBase += "/"
	}
	relayID, browserURL, err := s.meshGw.CreateDesktopTunnel(r.Context(), peerID, username, relayBase, record, viewOnly)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"relay_id":    relayID,
		"browser_url": browserURL,
	})
}

func (s *Server) handleMeshShareCreate(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	var body struct {
		TTLMinutes int  `json:"ttl_minutes"`
		ViewOnly   bool `json:"view_only"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	token, err := s.meshGw.CreateShareGrant(peerID, username, body.TTLMinutes, body.ViewOnly)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	path := "/remote/" + peerID + "?transport=mesh&mesh_share=" + token
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token":      token,
		"path":       path,
		"view_only":  body.ViewOnly,
		"ttl_minutes": body.TTLMinutes,
	})
}

func (s *Server) handleMeshShareValidate(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	peerID := strings.TrimSpace(r.URL.Query().Get("peer_id"))
	if token == "" || peerID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token and peer_id required"})
		return
	}
	grant, err := s.meshGw.ValidateShareGrant(token, peerID)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error(), "valid": "false"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"valid":      true,
		"peer_id":    grant.PeerID,
		"view_only":  grant.ViewOnly,
		"expires_at": grant.ExpiresAt,
	})
}

func (s *Server) handleMeshTerminalTunnel(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	relayBase := r.URL.Query().Get("relay_base")
	if relayBase == "" {
		relayBase = "/"
	}
	if !strings.HasSuffix(relayBase, "/") {
		relayBase += "/"
	}
	relayID, browserURL, err := s.meshGw.CreateTerminalTunnel(peerID, username, relayBase)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"relay_id":    relayID,
		"browser_url": browserURL,
	})
}

func (s *Server) handleMeshFilesTunnel(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	relayBase := r.URL.Query().Get("relay_base")
	if relayBase == "" {
		relayBase = "/"
	}
	if !strings.HasSuffix(relayBase, "/") {
		relayBase += "/"
	}
	relayID, browserURL, err := s.meshGw.CreateFilesTunnel(peerID, username, relayBase)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"relay_id":    relayID,
		"browser_url": browserURL,
	})
}

func (s *Server) handleMeshTcpRelay(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	var body struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	relayBase := r.URL.Query().Get("relay_base")
	if relayBase == "" {
		relayBase = "/"
	}
	if !strings.HasSuffix(relayBase, "/") {
		relayBase += "/"
	}
	relayID, browserURL, err := s.meshGw.CreateTcpRelayTunnel(peerID, username, relayBase, body.Host, body.Port)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"relay_id":    relayID,
		"browser_url": browserURL,
	})
}

func (s *Server) handleMeshUdpRelay(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	var body struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	relayBase := r.URL.Query().Get("relay_base")
	if relayBase == "" {
		relayBase = "/"
	}
	if !strings.HasSuffix(relayBase, "/") {
		relayBase += "/"
	}
	relayID, browserURL, err := s.meshGw.CreateUdpRelayTunnel(peerID, username, relayBase, body.Host, body.Port)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"relay_id":    relayID,
		"browser_url": browserURL,
	})
}

func (s *Server) handleMeshPower(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	var body struct {
		Action string `json:"action"`
		Forced bool   `json:"forced"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	actionType := meshPowerActionType(body.Action)
	if actionType == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown power action"})
		return
	}
	if err := s.meshGw.SendPowerAction(peerID, username, actionType, body.Forced); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent", "action": body.Action})
}

func meshPowerActionType(action string) int {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "wake", "wakeup", "on":
		return 6
	case "sleep":
		return 2
	case "off", "poweroff", "shutdown":
		return 3
	case "reset", "reboot":
		return 4
	default:
		return 0
	}
}

func (s *Server) handleMeshExec(w http.ResponseWriter, r *http.Request) {
	if s.meshGw == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mesh disabled"})
		return
	}
	peerID := r.PathValue("id")
	username := usernameFromRequest(r)
	var body struct {
		Command string `json:"command"`
		Shell   bool   `json:"shell"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.meshGw.SendRunCommand(peerID, username, body.Command, body.Shell); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Server) handleUnifiedPeerExec(w http.ResponseWriter, r *http.Request) {
	peerID := r.PathValue("id")
	var body struct {
		Command string `json:"command"`
		Shell   bool   `json:"shell"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	username := usernameFromRequest(r)
	if s.meshGw != nil && s.meshGw.IsConnected(peerID) {
		if err := s.meshGw.SendRunCommand(peerID, username, body.Command, body.Shell); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"transport": "mesh", "status": "sent"})
		return
	}
	if s.cdapGw != nil && s.cdapGw.IsConnected(peerID) {
		err := s.cdapGw.SendCommandJSON(r.Context(), peerID, "exec-"+peerID, "shell", "run",
			map[string]string{"command": body.Command}, username, "unified exec")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"transport": "cdap", "status": "sent"})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device not connected via mesh or cdap"})
}

func usernameFromRequest(r *http.Request) string {
	if u, ok := r.Context().Value(ctxKeyUser).(*db.User); ok && u != nil {
		return u.Username
	}
	if u, ok := r.Context().Value(ctxKeyUsername).(string); ok {
		return u
	}
	return "operator"
}
