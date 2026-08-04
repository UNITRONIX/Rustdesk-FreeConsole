package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

const orgSharedAddressBookEnabledKey = "shared_address_book_enabled"

// mergeAddressBookJSON merges overlay address books into base.
// Peers with the same id keep base fields; tags are unioned. Other top-level
// fields from base are preserved.
func mergeAddressBookJSON(base string, overlays ...string) string {
	merged := parseAddressBookMap(base)
	for _, overlay := range overlays {
		if strings.TrimSpace(overlay) == "" || overlay == "{}" {
			continue
		}
		merged = mergeAddressBookMaps(merged, parseAddressBookMap(overlay))
	}
	out, err := json.Marshal(merged)
	if err != nil {
		return base
	}
	return string(out)
}

func parseAddressBookMap(data string) map[string]any {
	ab := map[string]any{"peers": []any{}, "tags": []any{}}
	if strings.TrimSpace(data) == "" {
		return ab
	}
	if err := json.Unmarshal([]byte(data), &ab); err != nil {
		return map[string]any{"peers": []any{}, "tags": []any{}}
	}
	if ab == nil {
		ab = map[string]any{}
	}
	if _, ok := ab["peers"]; !ok {
		ab["peers"] = []any{}
	}
	if _, ok := ab["tags"]; !ok {
		ab["tags"] = []any{}
	}
	return ab
}

func mergeAddressBookMaps(base, overlay map[string]any) map[string]any {
	if base == nil {
		base = map[string]any{"peers": []any{}, "tags": []any{}}
	}
	if overlay == nil {
		return base
	}

	peerIndex := make(map[string]int)
	peers := toPeerSlice(base["peers"])
	for i, p := range peers {
		if id, ok := p["id"].(string); ok && id != "" {
			peerIndex[id] = i
		}
	}

	for _, p := range toPeerSlice(overlay["peers"]) {
		id, _ := p["id"].(string)
		if id == "" {
			continue
		}
		if idx, ok := peerIndex[id]; ok {
			peers[idx] = mergePeerMaps(peers[idx], p)
		} else {
			peerIndex[id] = len(peers)
			peers = append(peers, p)
		}
	}

	base["peers"] = peersToAny(peers)
	base["tags"] = unionTags(base["tags"], overlay["tags"])
	return base
}

func mergePeerMaps(base, overlay map[string]any) map[string]any {
	if base == nil {
		base = map[string]any{}
	}
	out := make(map[string]any, len(base)+len(overlay))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overlay {
		if k == "tags" {
			out[k] = unionTags(out[k], v)
			continue
		}
		if isEmptyABValue(out[k]) && !isEmptyABValue(v) {
			out[k] = v
		}
	}
	if _, ok := out["id"]; !ok {
		if id, ok := base["id"].(string); ok {
			out["id"] = id
		}
	}
	return out
}

func isEmptyABValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	default:
		return false
	}
}

func toPeerSlice(v any) []map[string]any {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, m)
	}
	return out
}

func peersToAny(peers []map[string]any) []any {
	out := make([]any, len(peers))
	for i, p := range peers {
		out[i] = p
	}
	return out
}

func unionTags(values ...any) []any {
	seen := make(map[string]bool)
	out := make([]any, 0)
	for _, v := range values {
		for _, tag := range toStringSlice(v) {
			if tag == "" || seen[tag] {
				continue
			}
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}

func toStringSlice(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, strings.TrimSpace(s))
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(t))
		for _, s := range t {
			out = append(out, strings.TrimSpace(s))
		}
		return out
	default:
		return nil
	}
}

func (s *Server) resolveUserOrgIDsForAB(r *http.Request) []string {
	seen := make(map[string]bool)
	var orgIDs []string

	if orgID := strings.TrimSpace(getOrgIDFromCtx(r)); orgID != "" {
		seen[orgID] = true
		orgIDs = append(orgIDs, orgID)
	}

	if user, ok := r.Context().Value(ctxKeyUser).(*db.User); ok && user != nil && user.ID > 0 {
		orgs, err := s.db.ListUserOrganizations(user.ID)
		if err != nil {
			log.Printf("[api] ListUserOrganizations for AB merge user=%d: %v", user.ID, err)
		} else {
			for _, org := range orgs {
				if org == nil || org.ID == "" || seen[org.ID] {
					continue
				}
				seen[org.ID] = true
				orgIDs = append(orgIDs, org.ID)
			}
		}
	}

	return orgIDs
}

func isOrgSettingNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "org setting not found:")
}

func orgSharedAddressBookEnabledFromValue(value string, err error) bool {
	if err != nil {
		if isOrgSettingNotFound(err) {
			return true
		}
		return false
	}
	return strings.ToLower(strings.TrimSpace(value)) != "false"
}

func (s *Server) orgSharedAddressBookEnabled(orgID string) bool {
	value, err := s.db.GetOrgSetting(orgID, orgSharedAddressBookEnabledKey)
	if err != nil {
		log.Printf("[api] GetOrgSetting(%s, %s): %v", orgID, orgSharedAddressBookEnabledKey, err)
		return orgSharedAddressBookEnabledFromValue("", err)
	}
	return orgSharedAddressBookEnabledFromValue(value, nil)
}

func (s *Server) mergeOrgAddressBooksIntoAB(r *http.Request, data string) string {
	orgIDs := s.resolveUserOrgIDsForAB(r)
	if len(orgIDs) == 0 {
		return data
	}

	overlays := make([]string, 0, len(orgIDs))
	for _, orgID := range orgIDs {
		if !s.orgSharedAddressBookEnabled(orgID) {
			continue
		}
		orgData, err := s.db.GetOrgAddressBook(orgID, "legacy")
		if err != nil {
			log.Printf("[api] GetOrgAddressBook org=%s: %v", orgID, err)
			continue
		}
		if strings.TrimSpace(orgData) != "" && orgData != "{}" {
			overlays = append(overlays, orgData)
		}
	}
	if len(overlays) == 0 {
		return data
	}
	return mergeAddressBookJSON(data, overlays...)
}

// emptyAddressBookPeersJSON is returned when scoped filtering cannot safely
// serialize the filtered book (fail closed — never return the unfiltered payload).
const emptyAddressBookPeersJSON = `{"peers":[],"tags":[]}`

// filterAddressBookPeersByVisibleSet strips peers outside the caller's device-group ACL.
// When visible is nil, no filtering is applied (unrestricted / admin).
// When knownPeers is non-empty, user-typed remote IDs (not in inventory) are kept.
// When knownPeers is empty under a non-nil visible set, allowlist-only: keep iff
// visible[id] — otherwise an empty inventory would fail open and re-expose a
// previously saved full fleet from POST /api/ab.
func filterAddressBookPeersByVisibleSet(data string, visible map[string]bool, knownPeers map[string]*db.Peer) string {
	if visible == nil {
		return data
	}
	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	filtered := make([]map[string]any, 0, len(peers))
	inventoryLoaded := len(knownPeers) > 0
	for _, p := range peers {
		id, _ := p["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if visible[id] {
			filtered = append(filtered, p)
			continue
		}
		if inventoryLoaded {
			if _, known := knownPeers[id]; !known {
				// User-typed remote ID not in server inventory — keep.
				filtered = append(filtered, p)
			}
		}
		// inventory empty → allowlist-only (drop non-visible, including "unknown")
	}
	ab["peers"] = peersToAny(filtered)
	out, err := json.Marshal(ab)
	if err != nil {
		return emptyAddressBookPeersJSON
	}
	return string(out)
}

// applyDeviceScopeToAddressBook filters Address Book peers with the same ACL as
// /api/peers/list (device groups, folders, peer grants, Restricted default).
// Pro accounts are scoped the same way as operators (no raw AB bypass).
func (s *Server) applyDeviceScopeToAddressBook(r *http.Request, username, role, data string) string {
	if auth.IsSuperAdminRole(role) || role == auth.RoleGlobalAdmin || role == auth.RoleServerAdmin {
		return data
	}
	user := s.rustDeskUserForGroups(r, username, role)
	peerByID, _ := s.loadRustDeskPeerByID(username, role)
	visible := s.rustDeskVisiblePeerSet(user, role, peerByID)
	// visible == nil means unrestricted (open mode, no scoped inventory). An empty
	// map means deny-all (panel ACL unavailable) — still strip known server peers.
	return filterAddressBookPeersByVisibleSet(data, visible, peerByID)
}
