// PanelSyncStore reads device groups, folders, and ACL for RustDesk client sync.
// Data lives in the consolidated PostgreSQL schema (formerly auth.db / console SQLite).
package db

// PanelSyncStore provides panel device groups, folders, and membership ACL.
type PanelSyncStore interface {
	GetUserIDByUsername(username string) (int64, error)
	ListPanelDeviceGroups() ([]PanelDeviceGroup, error)
	ListDeviceGroupMemberPeerIDs(deviceGroupID int64) ([]string, error)
	ListUserGroupGUIDsForUser(userID int64) ([]string, error)
	ListUserPeerGrants(userID int64) ([]string, error)
	ListFolders() ([]PanelFolder, error)
	ListFolderAssignments() (map[string]int64, error)
	ListPeerSysinfo() (map[string]ConsolePeerSysinfo, error)
	FolderGroupAccess(folderID int64) ([]string, []string, error)
	DeviceScopeDefaultRestricted() bool
}

// ConsoleAuthDB implements PanelSyncStore for legacy SQLite auth.db deployments.
var _ PanelSyncStore = (*ConsoleAuthDB)(nil)
