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

// buildRustDeskDeviceGroups returns panel device groups + folders for /api/group (not peer tags).
func (s *Server) buildRustDeskDeviceGroups(r *http.Request) []rustDeskGroup {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		return nil
	}
	if role == auth.RolePro || !auth.RoleHasPermission(role, auth.PermDeviceView) {
		return nil
	}

	user := s.rustDeskUserForGroups(r, username, role)
	if user == nil {
		return nil
	}

	peerByID, _ := s.loadRustDeskPeerByID(username, role)

	assignments := map[string]int64{}
	if s.panelStore != nil {
		if a, err := s.panelStore.ListFolderAssignments(); err == nil {
			assignments = a
		}
	}

	return s.buildRustDeskDeviceGroupsFromContext(user, role, peerByID, assignments)
}

func (s *Server) buildRustDeskDeviceGroupsFromContext(
	user *db.User,
	role string,
	peerByID map[string]*db.Peer,
	assignments map[string]int64,
) []rustDeskGroup {
	visiblePeer := s.rustDeskVisiblePeerSet(user, role, peerByID)
	userGroupGUIDs := s.consoleUserGroupGUIDs(user.ID)

	var groups []rustDeskGroup

	if s.panelStore != nil {
		panelGroups, err := s.panelStore.ListPanelDeviceGroups()
		if err != nil {
			log.Printf("[api] ListPanelDeviceGroups user=%s: %v", user.Username, err)
		} else if len(panelGroups) == 0 {
			log.Printf("[api] ListPanelDeviceGroups user=%s: 0 groups (check panel DB / device_groups table)", user.Username)
		} else {
			for _, g := range panelGroups {
				if !panelGroupAllowedForUser(g, user, role, userGroupGUIDs) {
					continue
				}
				groups = append(groups, rustDeskGroup{
					guid:    g.GUID,
					name:    g.Name,
					note:    g.Note,
					peerIDs: s.panelGroupPeerIDs(g, peerByID, visiblePeer),
				})
			}
		}

		folders, folderErr := s.panelStore.ListFolders()
		if folderErr != nil {
			log.Printf("[api] ListFolders user=%s: %v", user.Username, folderErr)
		}
		for _, folder := range folders {
			allowedUsers, allowedGroups, _ := s.panelStore.FolderGroupAccess(folder.ID)
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

	return groups
}

// rustDeskUserForGroups resolves the user row for ACL checks (Go DB, then JWT context, then auth.db id).
func (s *Server) rustDeskUserForGroups(r *http.Request, username, role string) *db.User {
	if u, err := s.db.GetUser(username); err == nil && u != nil {
		if s.panelStore != nil && u.ID > 0 {
			if authID, err := s.panelStore.GetUserIDByUsername(username); err == nil && authID > 0 {
				u.ID = authID
			}
		}
		return u
	}
	if v, ok := r.Context().Value(ctxKeyUser).(*db.User); ok && v != nil {
		return v
	}
	u := &db.User{Username: username, Role: role}
	if s.panelStore != nil {
		if authID, err := s.panelStore.GetUserIDByUsername(username); err == nil {
			u.ID = authID
		}
	}
	return u
}

func (s *Server) consoleUserGroupGUIDs(userID int64) map[string]bool {
	out := make(map[string]bool)
	if s.panelStore == nil || userID <= 0 {
		return out
	}
	guids, err := s.panelStore.ListUserGroupGUIDsForUser(userID)
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
	// Fail closed: empty ACL is private until users and/or user groups are attached.
	if len(allowedUsers) == 0 && len(allowedGroups) == 0 {
		return false
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

	if s.panelStore != nil {
		if members, err := s.panelStore.ListDeviceGroupMemberPeerIDs(g.ID); err == nil {
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
	if s.panelStore == nil {
		return nil
	}

	restrictedDefault := s.panelStore.DeviceScopeDefaultRestricted()

	var peerGrants []string
	if user != nil && user.ID > 0 {
		if grants, err := s.panelStore.ListUserPeerGrants(user.ID); err == nil {
			peerGrants = grants
		}
	}

	panelGroups, err := s.panelStore.ListPanelDeviceGroups()
	if err != nil {
		return nil
	}
	userGroupGUIDs := s.consoleUserGroupGUIDs(user.ID)

	assignments := map[string]int64{}
	if a, err := s.panelStore.ListFolderAssignments(); err == nil {
		assignments = a
	}

	folders, _ := s.panelStore.ListFolders()
	// Every device/folder group participates in scope. Empty ACL denies non-admins
	// and still hides member peers from the open overlay.
	hasScoped := len(panelGroups) > 0 || len(folders) > 0
	if !hasScoped && len(peerGrants) == 0 {
		if restrictedDefault {
			return map[string]bool{}
		}
		return nil
	}

	allowed := make(map[string]bool)
	restricted := make(map[string]bool)
	for _, g := range panelGroups {
		peerIDs := s.panelGroupPeerIDs(g, peerByID, nil)
		target := restricted
		if panelGroupAllowedForUser(g, user, role, userGroupGUIDs) {
			target = allowed
		}
		for _, id := range peerIDs {
			target[id] = true
		}
	}

	for _, folder := range folders {
		allowedUsers, allowedGroups, _ := s.panelStore.FolderGroupAccess(folder.ID)
		target := restricted
		if panelAccessAllowed(user, role, userGroupGUIDs, allowedUsers, allowedGroups) {
			target = allowed
		}
		for deviceID, folderID := range assignments {
			if folderID != folder.ID {
				continue
			}
			if _, ok := peerByID[deviceID]; !ok {
				continue
			}
			target[deviceID] = true
		}
	}
	for _, id := range peerGrants {
		allowed[id] = true
	}

	if restrictedDefault {
		return allowed
	}

	visible := make(map[string]bool)
	for id := range peerByID {
		if !restricted[id] || allowed[id] {
			visible[id] = true
		}
	}
	return visible
}

func folderGroupGUID(folderID int64) string {
	return fmt.Sprintf("folder_%d", folderID)
}

func isFolderGroupGUID(guid string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(guid)), "folder_")
}

// buildRustDeskPeerManualGroupNames maps peer IDs to panel device-group names.
// RustDesk desktop filters Available Devices by exact device_group_name match.
func buildRustDeskPeerManualGroupNames(groups []rustDeskGroup) map[string]string {
	out := make(map[string]string)
	for _, g := range groups {
		if isFolderGroupGUID(g.guid) {
			continue
		}
		for _, id := range g.peerIDs {
			if _, ok := out[id]; !ok {
				out[id] = g.name
			}
		}
	}
	return out
}

// rustDeskPeerDeviceGroupName is the sidebar group name RustDesk uses to filter peers.
// Folder assignment wins over manual/tag device groups when both apply.
func rustDeskPeerDeviceGroupName(
	peerID string,
	assignments map[string]int64,
	folderNames map[int64]string,
	manualGroupNames map[string]string,
) string {
	if fid, ok := assignments[peerID]; ok {
		if name := folderNames[fid]; name != "" {
			return name
		}
	}
	return manualGroupNames[peerID]
}

// rustDeskAccessibleDeviceGroupPayload matches RustDesk DeviceGroupPayload (name only).
func rustDeskAccessibleDeviceGroupPayload(g rustDeskGroup, index int) map[string]any {
	return map[string]any{
		"name": g.name,
		"guid": g.guid,
		"note": g.note,
		"sort": index,
	}
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
