package api

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

type rustDeskGroup struct {
	guid    string
	name    string
	note    string
	peerIDs []string
}

// buildRustDeskDeviceGroups mirrors web-nodejs getRustDeskDeviceGroups (panel auth.db + permissions).
func (s *Server) buildRustDeskDeviceGroups(r *http.Request) []rustDeskGroup {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		return nil
	}
	if role == auth.RolePro || !auth.RoleHasPermission(role, auth.PermDeviceView) {
		return nil
	}

	user, err := s.db.GetUser(username)
	if err != nil || user == nil {
		return nil
	}

	peers, _ := s.db.ListPeers(false)
	peerByID := make(map[string]*db.Peer, len(peers))
	for _, p := range peers {
		if p == nil || p.Banned || p.SoftDeleted || p.Disabled {
			continue
		}
		peerByID[p.ID] = p
	}

	visiblePeer := s.rustDeskVisiblePeerSet(user, role, peerByID)
	userGroupGUIDs := s.consoleUserGroupGUIDs(user.ID)

	var groups []rustDeskGroup

	if s.consoleAuth != nil {
		panelGroups, err := s.consoleAuth.ListPanelDeviceGroups()
		if err != nil {
			log.Printf("[api] ListPanelDeviceGroups: %v", err)
		} else {
			for _, g := range panelGroups {
				if !panelGroupAllowedForUser(g, user, role, userGroupGUIDs) {
					continue
				}
				peerIDs := s.panelGroupPeerIDs(g, peerByID, visiblePeer)
				groups = append(groups, rustDeskGroup{
					guid:    g.GUID,
					name:    g.Name,
					note:    g.Note,
					peerIDs: peerIDs,
				})
			}
		}

		assignments, _ := s.consoleAuth.ListFolderAssignments()
		folders, _ := s.consoleAuth.ListFolders()
		for _, folder := range folders {
			allowedUsers, allowedGroups, _ := s.consoleAuth.FolderGroupAccess(folder.ID)
			if !panelAccessAllowed(user, role, userGroupGUIDs, allowedUsers, allowedGroups) {
				continue
			}
			var peerIDs []string
			for deviceID, folderID := range assignments {
				if folderID != folder.ID {
					continue
				}
				if visiblePeer != nil && !visiblePeer[deviceID] {
					continue
				}
				if _, ok := peerByID[deviceID]; !ok {
					continue
				}
				peerIDs = append(peerIDs, deviceID)
			}
			groups = append(groups, rustDeskGroup{
				guid:    folderGroupGUID(folder.ID),
				name:    folder.Name,
				peerIDs: peerIDs,
			})
		}
	}

	// Fallback: peer tags as groups when auth.db is unavailable (legacy behaviour).
	if len(groups) == 0 && s.consoleAuth == nil {
		groups = s.peerTagGroups(peerByID, visiblePeer)
	}

	return groups
}

func (s *Server) consoleUserGroupGUIDs(userID int64) map[string]bool {
	out := make(map[string]bool)
	if s.consoleAuth == nil || userID <= 0 {
		return out
	}
	guids, err := s.consoleAuth.ListUserGroupGUIDsForUser(userID)
	if err != nil {
		log.Printf("[api] ListUserGroupGUIDsForUser: %v", err)
		return out
	}
	for _, g := range guids {
		out[g] = true
	}
	return out
}

func panelGroupAllowedForUser(g db.PanelDeviceGroup, user *db.User, role string, userGroupGUIDs map[string]bool) bool {
	return panelAccessAllowed(user, role, userGroupGUIDs, g.AllowedUsers, g.AllowedGroupGUIDs)
}

func panelAccessAllowed(user *db.User, role string, userGroupGUIDs map[string]bool, allowedUsers, allowedGroups []string) bool {
	if auth.IsSuperAdminRole(role) || role == auth.RoleGlobalAdmin || role == auth.RoleServerAdmin {
		return true
	}
	if len(allowedUsers) == 0 && len(allowedGroups) == 0 {
		return true
	}
	for _, u := range allowedUsers {
		if u == user.Username {
			return true
		}
	}
	for _, g := range allowedGroups {
		if userGroupGUIDs[g] {
			return true
		}
	}
	return false
}

func (s *Server) panelGroupPeerIDs(g db.PanelDeviceGroup, peerByID map[string]*db.Peer, visiblePeer map[string]bool) []string {
	seen := make(map[string]bool)
	var ids []string
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		if visiblePeer != nil && !visiblePeer[id] {
			return
		}
		if _, ok := peerByID[id]; !ok {
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}

	if s.consoleAuth != nil {
		if members, err := s.consoleAuth.ListDeviceGroupMemberPeerIDs(g.ID); err == nil {
			for _, id := range members {
				add(id)
			}
		}
	}

	if g.SourceType == "tag" && strings.TrimSpace(g.TagFilter) != "" {
		filter := strings.ToLower(strings.TrimSpace(g.TagFilter))
		for id, p := range peerByID {
			if peerHasTag(p, filter) {
				add(id)
			}
		}
	}
	return ids
}

func peerHasTag(p *db.Peer, tagLower string) bool {
	for _, t := range strings.Split(p.Tags, ",") {
		if strings.EqualFold(strings.TrimSpace(t), tagLower) {
			return true
		}
	}
	return false
}

// rustDeskVisiblePeerSet implements device group scope (restricted groups). nil = all peers visible.
func (s *Server) rustDeskVisiblePeerSet(user *db.User, role string, peerByID map[string]*db.Peer) map[string]bool {
	if auth.IsSuperAdminRole(role) || role == auth.RoleGlobalAdmin || role == auth.RoleServerAdmin {
		return nil
	}
	if s.consoleAuth == nil {
		return nil
	}
	panelGroups, err := s.consoleAuth.ListPanelDeviceGroups()
	if err != nil {
		return nil
	}
	userGroupGUIDs := s.consoleUserGroupGUIDs(user.ID)

	hasRestricted := false
	for _, g := range panelGroups {
		if len(g.AllowedUsers) > 0 || len(g.AllowedGroupGUIDs) > 0 {
			hasRestricted = true
			break
		}
	}
	if !hasRestricted {
		return nil
	}

	allowed := make(map[string]bool)
	restricted := make(map[string]bool)
	for _, g := range panelGroups {
		if len(g.AllowedUsers) == 0 && len(g.AllowedGroupGUIDs) == 0 {
			continue
		}
		peerIDs := s.panelGroupPeerIDs(g, peerByID, nil)
		target := restricted
		if panelGroupAllowedForUser(g, user, role, userGroupGUIDs) {
			target = allowed
		}
		for _, id := range peerIDs {
			target[id] = true
		}
	}

	visible := make(map[string]bool)
	for id := range peerByID {
		if !restricted[id] || allowed[id] {
			visible[id] = true
		}
	}
	return visible
}

func (s *Server) peerTagGroups(peerByID map[string]*db.Peer, visiblePeer map[string]bool) []rustDeskGroup {
	tagPeers := make(map[string][]string)
	tagOrder := make([]string, 0)
	for id, p := range peerByID {
		if visiblePeer != nil && !visiblePeer[id] {
			continue
		}
		if p.Tags == "" {
			continue
		}
		for _, tag := range strings.Split(p.Tags, ",") {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			if _, exists := tagPeers[tag]; !exists {
				tagOrder = append(tagOrder, tag)
			}
			tagPeers[tag] = append(tagPeers[tag], id)
		}
	}
	groups := make([]rustDeskGroup, 0, len(tagOrder))
	for _, tag := range tagOrder {
		groups = append(groups, rustDeskGroup{
			guid:    tag,
			name:    tag,
			peerIDs: tagPeers[tag],
		})
	}
	return groups
}

func folderGroupGUID(folderID int64) string {
	return fmt.Sprintf("folder_%d", folderID)
}

func rustDeskGroupPayload(g rustDeskGroup, index int) map[string]any {
	peerRefs := make([]map[string]any, 0, len(g.peerIDs))
	for _, pid := range g.peerIDs {
		peerRefs = append(peerRefs, map[string]any{"id": pid})
	}
	return map[string]any{
		"guid":        g.guid,
		"name":        g.name,
		"team":        map[string]any{"peers": peerRefs},
		"access_perm": 1,
		"note":        g.note,
		"created_at":  "",
		"sort":        index,
	}
}
