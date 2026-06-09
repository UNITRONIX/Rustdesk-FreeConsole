package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
)

// buildRustDeskPeerList mirrors web-nodejs getRustDeskPeerList (folders, groups, tags, ACL).
func (s *Server) buildRustDeskPeerList(r *http.Request) ([]map[string]any, int) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" || role == auth.RolePro || !auth.RoleHasPermission(role, auth.PermDeviceView) {
		return nil, 0
	}

	user := s.rustDeskUserForGroups(r, username, role)
	if user == nil {
		return nil, 0
	}

	allPeers, err := s.db.ListPeers(false)
	if err != nil {
		return nil, 0
	}

	peerByID := make(map[string]*db.Peer, len(allPeers))
	for _, p := range allPeers {
		if p == nil || p.Banned || p.SoftDeleted || p.Disabled {
			continue
		}
		peerByID[p.ID] = p
	}

	folderAssignments := map[string]int64{}
	folderNames := map[int64]string{}
	if s.panelStore != nil {
		if a, err := s.panelStore.ListFolderAssignments(); err == nil {
			folderAssignments = a
		}
		if folders, err := s.panelStore.ListFolders(); err == nil {
			for _, f := range folders {
				folderNames[f.ID] = f.Name
			}
		}
	}

	sysinfoMap := map[string]db.ConsolePeerSysinfo{}
	if s.panelStore != nil {
		if m, err := s.panelStore.ListPeerSysinfo(); err == nil {
			sysinfoMap = m
		}
	}

	visiblePeer := s.rustDeskVisiblePeerSet(user, role, peerByID)
	if !canBrowseRustDeskInventory(role) {
		allowed := s.addressBookPeerIDs(username)
		filtered := make(map[string]*db.Peer, len(allowed))
		for id := range allowed {
			if p, ok := peerByID[id]; ok {
				if visiblePeer == nil || visiblePeer[id] {
					filtered[id] = p
				}
			}
		}
		peerByID = filtered
	} else if visiblePeer != nil {
		filtered := make(map[string]*db.Peer, len(visiblePeer))
		for id := range peerByID {
			if visiblePeer[id] {
				filtered[id] = peerByID[id]
			}
		}
		peerByID = filtered
	}

	params := parseRustDeskPeerListParams(r)
	peerByID = filterPeersByRustDeskParams(s, peerByID, folderAssignments, params, user, role)

	deviceGroups := s.buildRustDeskDeviceGroupsFromContext(user, role, peerByID, folderAssignments)
	manualGroupNames := buildRustDeskPeerManualGroupNames(deviceGroups)

	abPeerMap := s.loadAddressBookPeerMap(username)

	result := make([]map[string]any, 0, len(peerByID))
	for _, p := range peerByID {
		result = append(result, rustDeskPeerPayload(s, p, folderAssignments, folderNames, manualGroupNames, sysinfoMap, abPeerMap))
	}

	total := len(result)
	page := params.page
	pageSize := params.pageSize
	if pageSize > 0 && total > pageSize {
		start := (page - 1) * pageSize
		if start < 0 {
			start = 0
		}
		end := start + pageSize
		if end > total {
			end = total
		}
		if start >= total {
			result = []map[string]any{}
		} else {
			result = result[start:end]
		}
	}

	return result, total
}

func canBrowseRustDeskInventory(role string) bool {
	return role != auth.RolePro && auth.RoleHasPermission(role, auth.PermDeviceView)
}

func (s *Server) addressBookPeerIDs(username string) map[string]bool {
	out := make(map[string]bool)
	for _, abType := range []string{"legacy", "personal"} {
		data, err := s.db.GetAddressBook(username, abType)
		if err != nil || data == "" || data == "{}" {
			continue
		}
		var ab struct {
			Peers []map[string]any `json:"peers"`
		}
		if json.Unmarshal([]byte(data), &ab) != nil {
			continue
		}
		for _, p := range ab.Peers {
			if id, ok := p["id"].(string); ok && id != "" {
				out[id] = true
			}
		}
	}
	return out
}

func (s *Server) loadAddressBookPeerMap(username string) map[string]map[string]any {
	out := make(map[string]map[string]any)
	data, _ := s.db.GetAddressBook(username, "legacy")
	if data == "" || data == "{}" {
		return out
	}
	var ab struct {
		Peers []map[string]any `json:"peers"`
	}
	if json.Unmarshal([]byte(data), &ab) != nil {
		return out
	}
	for _, p := range ab.Peers {
		if id, ok := p["id"].(string); ok && id != "" {
			out[id] = p
		}
	}
	return out
}

type rustDeskPeerListParams struct {
	page     int
	pageSize int
	folderID *int64
	groupRef string
	tags     []string
}

func parseRustDeskPeerListParams(r *http.Request) rustDeskPeerListParams {
	params := rustDeskPeerListParams{
		page:     1,
		pageSize: 100,
	}
	q := r.URL.Query()
	if r.Method == http.MethodPost && r.Body != nil {
		body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err == nil && len(body) > 0 {
			var post map[string]any
			if json.Unmarshal(body, &post) == nil {
				for k, v := range post {
					q.Set(k, stringifyQueryVal(v))
				}
			}
			r.Body = io.NopCloser(strings.NewReader(string(body)))
		}
	}
	if v := q.Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			params.page = n
		}
	}
	if v := q.Get("page_size"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			params.pageSize = n
		}
	}
	if v := q.Get("pageSize"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			params.pageSize = n
		}
	}
	if params.pageSize > 200 {
		params.pageSize = 200
	}
	params.groupRef = firstQueryGroupRef(q)
	if fid := folderIDFromGroupRef(params.groupRef); fid != nil {
		params.folderID = fid
	}
	params.tags = splitQueryTags(q.Get("tag"), q.Get("tags"), q.Get("tag_filter"), q.Get("tagFilter"))
	return params
}

func stringifyQueryVal(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		return ""
	}
}

func firstQueryGroupRef(q map[string][]string) string {
	keys := []string{
		"folder_id", "folderId", "folder", "folder_name", "folderName",
		"device_group_guid", "deviceGroupGuid", "device_group_id", "deviceGroupId",
		"device_group", "deviceGroup", "group_guid", "groupGuid", "group_id", "groupId",
		"group_name", "groupName", "group",
	}
	for _, key := range keys {
		for _, v := range q[key] {
			if s := strings.TrimSpace(v); s != "" {
				return s
			}
		}
	}
	return ""
}

func folderIDFromGroupRef(ref string) *int64 {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil
	}
	if strings.HasPrefix(strings.ToLower(ref), "folder_") {
		ref = ref[7:]
	}
	if n, err := strconv.ParseInt(ref, 10, 64); err == nil {
		return &n
	}
	return nil
}

func splitQueryTags(values ...string) []string {
	var out []string
	seen := make(map[string]bool)
	for _, raw := range values {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" || seen[strings.ToLower(part)] {
				continue
			}
			seen[strings.ToLower(part)] = true
			out = append(out, part)
		}
	}
	return out
}

func filterPeersByRustDeskParams(
	s *Server,
	peerByID map[string]*db.Peer,
	assignments map[string]int64,
	params rustDeskPeerListParams,
	user *db.User,
	role string,
) map[string]*db.Peer {
	if params.folderID != nil {
		out := make(map[string]*db.Peer)
		for id, p := range peerByID {
			if assignments[id] == *params.folderID {
				out[id] = p
			}
		}
		return out
	}
	if params.groupRef != "" {
		groups := s.buildRustDeskDeviceGroupsFromContext(user, role, peerByID, assignments)
		ref := strings.TrimSpace(params.groupRef)
		refLower := strings.ToLower(ref)
		for _, g := range groups {
			if strings.EqualFold(g.guid, ref) || strings.EqualFold(g.name, ref) {
				out := make(map[string]*db.Peer)
				for _, id := range g.peerIDs {
					if p, ok := peerByID[id]; ok {
						out[id] = p
					}
				}
				return out
			}
		}
		if refLower != "" {
			out := make(map[string]*db.Peer)
			for id, p := range peerByID {
				if peerHasTagLower(p, refLower) {
					out[id] = p
				}
			}
			return out
		}
		return map[string]*db.Peer{}
	}
	if len(params.tags) > 0 {
		out := make(map[string]*db.Peer)
		for id, p := range peerByID {
			if peerHasAllTagsLower(p, params.tags) {
				out[id] = p
			}
		}
		return out
	}
	return peerByID
}

func peerHasTagLower(p *db.Peer, tagLower string) bool {
	for _, t := range strings.Split(p.Tags, ",") {
		if strings.ToLower(strings.TrimSpace(t)) == tagLower {
			return true
		}
	}
	return false
}

func peerHasAllTagsLower(p *db.Peer, expected []string) bool {
	for _, want := range expected {
		if !peerHasTagLower(p, strings.ToLower(strings.TrimSpace(want))) {
			return false
		}
	}
	return true
}

func rustDeskPeerPayload(
	s *Server,
	p *db.Peer,
	assignments map[string]int64,
	folderNames map[int64]string,
	manualGroupNames map[string]string,
	sysinfo map[string]db.ConsolePeerSysinfo,
	abPeer map[string]map[string]any,
) map[string]any {
	statusInt := 1
	if p.Disabled {
		statusInt = 0
	}

	deviceName := p.Hostname
	username := p.User
	platform := p.OS
	version := p.Version
	if si, ok := sysinfo[p.ID]; ok {
		if si.Hostname != "" {
			deviceName = si.Hostname
		}
		if si.Username != "" {
			username = si.Username
		}
		if si.Platform != "" {
			platform = si.Platform
		}
		if si.Version != "" {
			version = si.Version
		}
	}
	if deviceName == "" {
		deviceName = p.ID
	}

	tags := splitPeerTags(p.Tags)
	deviceGroupName := rustDeskPeerDeviceGroupName(p.ID, assignments, folderNames, manualGroupNames)

	alias := p.Note
	if abPeer != nil {
		if ab, ok := abPeer[p.ID]; ok {
			if a, ok := ab["alias"].(string); ok && a != "" {
				alias = a
			}
		}
	}

	online := s.peers.IsOnline(p.ID, config.RegTimeout)

	return map[string]any{
		"id":     p.ID,
		"info":   map[string]any{"device_name": deviceName, "os": platform, "username": username, "version": version},
		"status": statusInt,
		"user":   username, "user_name": username,
		"note":              p.Note,
		"device_group_name": deviceGroupName,
		"tags":              tags,
		"online":            online,
		"alias":             alias,
		"hash":              "",
	}
}

func splitPeerTags(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var tags []string
	for _, t := range strings.Split(raw, ",") {
		t = strings.TrimSpace(t)
		if t != "" {
			tags = append(tags, t)
		}
	}
	return tags
}

// syncServerTagsIntoAddressBook merges visible server peer tags into legacy AB JSON
// so the RustDesk desktop client sidebar ("Tagi") lists panel tags after GET /api/ab.
func (s *Server) syncServerTagsIntoAddressBook(data string, r *http.Request, username, role string) string {
	ab := map[string]any{}
	if data != "" && data != "{}" {
		if err := json.Unmarshal([]byte(data), &ab); err != nil {
			return data
		}
	}
	if ab["peers"] == nil {
		ab["peers"] = []any{}
	}

	serverTags := s.collectRustDeskTags(r, username, role)
	if len(serverTags) == 0 {
		out, err := json.Marshal(ab)
		if err != nil {
			return data
		}
		return string(out)
	}

	const maxAddressBookTags = 4096
	var existing []string
	switch raw := ab["tags"].(type) {
	case []any:
		for _, t := range raw {
			if s, ok := t.(string); ok && s != "" {
				existing = append(existing, s)
			}
			if len(existing) >= maxAddressBookTags {
				break
			}
		}
	case []string:
		if len(raw) > maxAddressBookTags {
			existing = append(existing, raw[:maxAddressBookTags]...)
		} else {
			existing = append(existing, raw...)
		}
	}
	if len(serverTags) > maxAddressBookTags {
		serverTags = serverTags[:maxAddressBookTags]
	}
	seenCap := len(existing) + len(serverTags)
	if seenCap > maxAddressBookTags*2 {
		seenCap = maxAddressBookTags * 2
	}
	seen := make(map[string]bool, seenCap)
	for _, t := range existing {
		seen[strings.ToLower(strings.TrimSpace(t))] = true
	}
	for _, t := range serverTags {
		low := strings.ToLower(strings.TrimSpace(t))
		if low != "" && !seen[low] {
			existing = append(existing, t)
			seen[low] = true
		}
	}
	ab["tags"] = existing

	out, err := json.Marshal(ab)
	if err != nil {
		return data
	}
	return string(out)
}

// collectRustDeskTags returns address-book + server peer tags (not group/folder names).
func (s *Server) collectRustDeskTags(r *http.Request, username string, role string) []string {
	data, err := s.db.GetAddressBook(username, "legacy")
	if err != nil {
		data = "{}"
	}
	if !auth.IsProRole(role) {
		data = s.mergeAdminTagsIntoAB(data)
	}

	var ab struct {
		Tags []string `json:"tags"`
	}
	if json.Unmarshal([]byte(data), &ab) != nil || ab.Tags == nil {
		ab.Tags = []string{}
	}

	if role == auth.RolePro || !auth.RoleHasPermission(role, auth.PermDeviceView) {
		return ab.Tags
	}

	seen := make(map[string]bool, len(ab.Tags))
	for _, tag := range ab.Tags {
		seen[strings.ToLower(strings.TrimSpace(tag))] = true
	}

	if peers, err := s.db.ListPeers(false); err == nil {
		for _, p := range peers {
			if p == nil || p.Banned || p.SoftDeleted {
				continue
			}
			for _, tag := range splitPeerTags(p.Tags) {
				low := strings.ToLower(tag)
				if !seen[low] {
					ab.Tags = append(ab.Tags, tag)
					seen[low] = true
				}
			}
		}
	}

	return ab.Tags
}
