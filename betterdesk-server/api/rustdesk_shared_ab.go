package api

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/unitronix/betterdesk-server/auth"
)

// Stable shared address book for Access Policy password auto-connect.
// Stock RustDesk only applies peers[].password when connecting from a
// non-personal (shared) address book — legacy /api/ab is treated as personal
// and Groups never receive passwords (PeerPayload.toPeer drops them).
const (
	sharedDevicesABGUID = "betterdesk-devices"
	sharedDevicesABName = "Devices"
)

var personalABNamespace = uuid.MustParse("6ba7b810-9dad-11d1-80b4-00c04fd430c8") // DNS namespace

func personalABGUID(username string) string {
	username = strings.TrimSpace(strings.ToLower(username))
	if username == "" {
		username = "anonymous"
	}
	return uuid.NewSHA1(personalABNamespace, []byte("betterdesk-personal:"+username)).String()
}

func (s *Server) handleClientABSettings(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	// 0 = unlimited (matches stock Pro / jjairola rustdesk-api).
	writeJSON(w, http.StatusOK, map[string]any{"max_peer_one_ab": 0})
}

func (s *Server) handleClientABSharedProfiles(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	profiles := []map[string]any{{
		"guid":  sharedDevicesABGUID,
		"name":  sharedDevicesABName,
		"owner": "system",
		"note":  "Devices with Access Policy passwords for one-click connect",
		"rule":  1, // read-only
		"info":  nil,
	}}
	current, pageSize := parseABPageQuery(r)
	total, page := paginateAnyMaps(profiles, current, pageSize)
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "data": page})
}

func (s *Server) handleClientABPeers(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	guid := strings.TrimSpace(r.URL.Query().Get("ab"))
	current, pageSize := parseABPageQuery(r)

	var peers []map[string]any
	switch {
	case guid == "" || guid == personalABGUID(username):
		peers = s.personalABPeersForPro(username, role)
	case guid == sharedDevicesABGUID:
		peers = s.sharedDevicesABPeers(r, username, role)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"total": 0, "data": []any{}})
		return
	}

	total, page := paginateAnyMaps(peers, current, pageSize)
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "data": page})
}

func (s *Server) handleClientABTagsByGUID(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	guid := r.PathValue("guid")
	username := getUsernameFromCtx(r)

	if guid == sharedDevicesABGUID {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	if guid == personalABGUID(username) {
		data, err := s.db.GetAddressBook(username, "personal")
		if err != nil {
			data, _ = s.db.GetAddressBook(username, "legacy")
		}
		ab := parseAddressBookMap(data)
		tags := toStringSlice(ab["tags"])
		out := make([]map[string]any, 0, len(tags))
		for _, tag := range tags {
			out = append(out, map[string]any{"name": tag, "color": 4288585374})
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	writeJSON(w, http.StatusOK, []any{})
}

// Shared book is read-only; personal writes are accepted as no-op success so the
// client does not toast errors while we keep legacy GET/POST /api/ab working.
func (s *Server) handleClientABPeerMutation(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	guid := r.PathValue("guid")
	if guid == sharedDevicesABGUID {
		writeJSON(w, http.StatusOK, map[string]string{
			"error": `"Devices" is read-only; Access Policy passwords are filled automatically`,
		})
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleClientABTagMutation(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	guid := r.PathValue("guid")
	if guid == sharedDevicesABGUID {
		writeJSON(w, http.StatusOK, map[string]string{"error": `"Devices" is read-only`})
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) personalABPeersForPro(username, role string) []map[string]any {
	data, err := s.db.GetAddressBook(username, "personal")
	if err != nil || strings.TrimSpace(data) == "" || data == "{}" {
		data, _ = s.db.GetAddressBook(username, "legacy")
	}
	if !auth.IsProRole(role) {
		data = s.mergeAdminTagsIntoAB(data)
	}
	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	out := make([]map[string]any, 0, len(peers))
	for _, p := range peers {
		id, _ := p["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		out = append(out, rustDeskABPeerJSON(p, ""))
	}
	return out
}

func (s *Server) sharedDevicesABPeers(r *http.Request, username, _ string) []map[string]any {
	list, _ := s.buildRustDeskPeerList(r)
	ids := make([]string, 0, len(list))
	for _, item := range list {
		if id, ok := item["id"].(string); ok && id != "" {
			ids = append(ids, id)
		}
	}
	passwords := s.resolveAccessPasswordsForPeers(username, ids)

	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		id, _ := item["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		info, _ := item["info"].(map[string]any)
		if info == nil {
			info = map[string]any{}
		}
		alias, _ := item["alias"].(string)
		note, _ := item["note"].(string)
		tags := item["tags"]
		usernameField, _ := info["username"].(string)
		if usernameField == "" {
			usernameField, _ = item["user_name"].(string)
		}
		hostname, _ := info["device_name"].(string)
		platform, _ := info["os"].(string)
		peer := map[string]any{
			"id":       id,
			"alias":    alias,
			"note":     note,
			"tags":     tags,
			"username": usernameField,
			"hostname": hostname,
			"platform": platform,
		}
		out = append(out, rustDeskABPeerJSON(peer, passwords[id]))
	}
	return out
}

func rustDeskABPeerJSON(peer map[string]any, password string) map[string]any {
	id, _ := peer["id"].(string)
	alias, _ := peer["alias"].(string)
	note, _ := peer["note"].(string)
	username, _ := peer["username"].(string)
	hostname, _ := peer["hostname"].(string)
	platform, _ := peer["platform"].(string)
	hash, _ := peer["hash"].(string)
	if password == "" {
		password, _ = peer["password"].(string)
	}
	tags := peer["tags"]
	if tags == nil {
		tags = []any{}
	}
	return map[string]any{
		"id":                id,
		"username":          username,
		"hostname":          hostname,
		"platform":          platform,
		"alias":             alias,
		"tags":              tags,
		"note":              note,
		"hash":              hash,
		"password":          password,
		"forceAlwaysRelay":  "false",
		"rdpPort":           "",
		"rdpUsername":       "",
		"loginName":         "",
		"device_group_name": "",
		"same_server":       true,
	}
}

func parseABPageQuery(r *http.Request) (current, pageSize int) {
	current, _ = strconv.Atoi(r.URL.Query().Get("current"))
	pageSize, _ = strconv.Atoi(r.URL.Query().Get("pageSize"))
	if current < 1 {
		current = 1
	}
	if pageSize < 1 {
		pageSize = 100
	}
	return current, pageSize
}

func paginateAnyMaps(items []map[string]any, current, pageSize int) (int, []map[string]any) {
	total := len(items)
	if pageSize <= 0 || current <= 0 {
		return total, items
	}
	start := (current - 1) * pageSize
	if start < 0 {
		start = 0
	}
	if start >= total {
		return total, []map[string]any{}
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	return total, items[start:end]
}

// resolveAccessPasswordsForPeers decrypts sealed Access Policy passwords for
// peers that have unattended + passwordless server access enabled.
func (s *Server) resolveAccessPasswordsForPeers(username string, peerIDs []string) map[string]string {
	out := make(map[string]string)
	if s == nil || s.db == nil || s.accessSecret == nil || len(peerIDs) == 0 {
		return out
	}
	policies, err := s.db.GetAccessPoliciesByPeerIDs(peerIDs)
	if err != nil {
		log.Printf("[api] GetAccessPoliciesByPeerIDs: %v", err)
		return out
	}
	for id, policy := range policies {
		if !accessPolicyEligibleForABPassword(policy) {
			continue
		}
		if !operatorAllowedForAccessPolicy(username, policy.AllowedOperators) {
			continue
		}
		plain, err := s.accessSecret.Decrypt(policy.PasswordEnc)
		if err != nil || plain == "" {
			continue
		}
		out[id] = plain
	}
	return out
}
