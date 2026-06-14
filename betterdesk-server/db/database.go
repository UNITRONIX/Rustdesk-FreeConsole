// Package db defines the database interface and models for the BetterDesk server.
// Implementations: sqlite.go (default), postgres.go (PostgreSQL via pgx/v5).
package db

import "time"

// Peer represents a registered RustDesk device.
type Peer struct {
	ID           string     `json:"id"`
	UUID         string     `json:"uuid"`
	PK           []byte     `json:"pk"`
	IP           string     `json:"ip"`
	User         string     `json:"user,omitempty"`
	Hostname     string     `json:"hostname,omitempty"`
	OS           string     `json:"os,omitempty"`
	Version      string     `json:"version,omitempty"`
	Status       string     `json:"status"` // ONLINE, OFFLINE, DEGRADED, CRITICAL
	NATType      int        `json:"nat_type"`
	LastOnline   time.Time  `json:"last_online"`
	CreatedAt    time.Time  `json:"created_at"`
	Disabled     bool       `json:"disabled"`
	Banned       bool       `json:"banned"`
	BanReason    string     `json:"ban_reason,omitempty"`
	BannedAt     *time.Time `json:"banned_at,omitempty"`
	SoftDeleted  bool       `json:"soft_deleted"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty"`
	Note         string     `json:"note,omitempty"`
	Tags         string     `json:"tags,omitempty"`
	DisplayName  string     `json:"display_name"`             // Admin-set alias (overrides hostname in UI)
	DeviceType   string     `json:"device_type,omitempty"`    // CDAP: desktop, mobile, headless, kiosk, etc.
	LinkedPeerID string     `json:"linked_peer_id,omitempty"` // CDAP: paired device (e.g., mobile→desktop)
	HeartbeatSeq int64      `json:"-"`                        // internal heartbeat counter
}

// ServerConfig stores runtime configuration in the database.
type ServerConfig struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// User represents an API user account.
// Authentication provider values for User.AuthProvider. Determines how an
// account is allowed to authenticate. A user bound to a non-local provider
// can ONLY authenticate via that provider — password login is rejected even
// when a username collides with a local account (Issue #148).
const (
	AuthProviderLocal = "local" // local password (PBKDF2/bcrypt)
	AuthProviderLDAP  = "ldap"  // LDAP / Active Directory
	AuthProviderOIDC  = "oidc"  // OpenID Connect / OAuth2 SSO
)

type User struct {
	ID                int64  `json:"id"`
	Username          string `json:"username"`
	PasswordHash      string `json:"-"`
	Role              string `json:"role"`            // admin, operator, viewer
	IsServerAdmin     bool   `json:"is_server_admin"` // Phase 3: separate server admin flag
	AuthProvider      string `json:"auth_provider"`   // local, ldap, oidc (Issue #148)
	TOTPSecret        string `json:"-"`
	TOTPEnabled       bool   `json:"totp_enabled"`
	TOTPRecoveryCodes string `json:"-"` // JSON array of bcrypt-hashed recovery codes (H4)
	CreatedAt         string `json:"created_at"`
	LastLogin         string `json:"last_login,omitempty"`
}

// RolePermission represents a custom permission override for a role.
// Stored in the role_permissions table. If no override exists for a role+permission,
// the default from auth.DefaultRolePermissions is used.
type RolePermission struct {
	ID         int64  `json:"id"`
	Role       string `json:"role"`
	Permission string `json:"permission"` // e.g. "device.view", "user.manage"
	Granted    bool   `json:"granted"`    // true = allowed, false = denied
}

// APIKey represents a scoped API key for programmatic access.
type APIKey struct {
	ID        int64  `json:"id"`
	KeyHash   string `json:"-"`
	KeyPrefix string `json:"key_prefix"` // First 8 chars for identification
	Name      string `json:"name"`
	Role      string `json:"role"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at,omitempty"`
	LastUsed  string `json:"last_used,omitempty"`
}

// IDChangeHistory tracks peer ID changes.
type IDChangeHistory struct {
	OldID     string    `json:"old_id"`
	NewID     string    `json:"new_id"`
	ChangedAt time.Time `json:"changed_at"`
	Reason    string    `json:"reason,omitempty"`
}

// PeerMetric represents a single heartbeat metric data point.
type PeerMetric struct {
	ID        int64     `json:"id"`
	PeerID    string    `json:"peer_id"`
	CPU       float64   `json:"cpu_usage"`
	Memory    float64   `json:"memory_usage"`
	Disk      float64   `json:"disk_usage"`
	CreatedAt time.Time `json:"created_at"`
}

// DeviceToken represents a unique enrollment token for device registration.
// Dual Key System: supports both global server key (backward compatible) and
// per-device tokens for enhanced security.
type DeviceToken struct {
	ID         int64      `json:"id"`
	Token      string     `json:"token"`             // Unique enrollment token (32 chars)
	TokenHash  string     `json:"-"`                 // SHA256 hash for storage
	Name       string     `json:"name"`              // Friendly name for the token
	PeerID     string     `json:"peer_id,omitempty"` // Bound peer ID (after enrollment)
	Status     string     `json:"status"`            // pending, active, revoked, expired
	MaxUses    int        `json:"max_uses"`          // 0 = unlimited, 1 = single-use
	UseCount   int        `json:"use_count"`         // Current use count
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"` // Optional expiration
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	CreatedBy  string     `json:"created_by,omitempty"` // Admin who created the token
	Note       string     `json:"note,omitempty"`
}

// DeviceTokenStatus constants
const (
	TokenStatusPending = "pending" // Created, not yet used
	TokenStatusActive  = "active"  // Bound to a peer
	TokenStatusRevoked = "revoked" // Manually revoked
	TokenStatusExpired = "expired" // Past expiration date
)

// ChatMessage represents a persisted chat message between devices/operators.
type ChatMessage struct {
	ID             int64     `json:"id"`
	ConversationID string    `json:"conversation_id"` // "operator", device_id, or group:<id>
	FromID         string    `json:"from_id"`         // sender device_id or "operator:<name>"
	FromName       string    `json:"from_name"`       // display name
	ToID           string    `json:"to_id,omitempty"` // recipient device_id or group ID
	Text           string    `json:"text"`
	Read           bool      `json:"read"`
	CreatedAt      time.Time `json:"created_at"`
}

// ChatGroup represents a multi-device chat group.
type ChatGroup struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Members   string    `json:"members"`    // comma-separated device IDs
	CreatedBy string    `json:"created_by"` // device_id or operator name
	CreatedAt time.Time `json:"created_at"`
}

// ChatContact represents a peer visible for chat (derived from peers table).
type ChatContact struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Hostname    string `json:"hostname"`
	Online      bool   `json:"online"`
	LastSeen    int64  `json:"last_seen"`
	Unread      int    `json:"unread"`
	AvatarColor string `json:"avatar_color"`
}

// HelpRequest status constants.
const (
	HelpStatusPending      = "pending"      // Raised by device, awaiting operator
	HelpStatusAcknowledged = "acknowledged" // Operator picked it up
	HelpStatusResolved     = "resolved"     // Operator closed it
	HelpStatusCancelled    = "cancelled"    // Device cancelled it
)

// HelpRequest represents a support request raised by an agent device.
type HelpRequest struct {
	ID        int64     `json:"id"`
	DeviceID  string    `json:"device_id"`
	Hostname  string    `json:"hostname,omitempty"`
	OrgID     string    `json:"org_id,omitempty"`
	Message   string    `json:"message"`
	Status    string    `json:"status"`
	HandledBy string    `json:"handled_by,omitempty"` // operator that acked/resolved
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// HelpRequestFilter narrows ListHelpRequests results. Empty fields match any.
type HelpRequestFilter struct {
	Status   string // "" = any status
	DeviceID string // "" = any device
	OrgID    string // "" = any org (org data-scoping)
	Limit    int    // 0 = default (100)
}

// Organization represents a customer/tenant entity.
type Organization struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	LogoURL   string    `json:"logo_url,omitempty"`
	Settings  string    `json:"settings,omitempty"` // JSON blob for org-level settings
	CreatedAt time.Time `json:"created_at"`
}

// OrgUser represents a user account within an organization.
// Can be either a standalone org-scoped user (password_hash set) or a linked
// server-level user (server_user_id set, password_hash empty).
type OrgUser struct {
	ID           string     `json:"id"`
	OrgID        string     `json:"org_id"`
	ServerUserID int64      `json:"server_user_id,omitempty"` // FK to users.id (0 = standalone org user)
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name,omitempty"`
	Email        string     `json:"email,omitempty"`
	PasswordHash string     `json:"-"`
	Role         string     `json:"role"` // owner, admin, operator, user
	TOTPSecret   string     `json:"-"`
	AvatarURL    string     `json:"avatar_url,omitempty"`
	LastLogin    *time.Time `json:"last_login,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

// OrgDevice binds a device to an organization with metadata.
type OrgDevice struct {
	OrgID          string `json:"org_id"`
	DeviceID       string `json:"device_id"`
	AssignedUserID string `json:"assigned_user_id,omitempty"`
	Department     string `json:"department,omitempty"`
	Location       string `json:"location,omitempty"`
	Building       string `json:"building,omitempty"`
	Tags           string `json:"tags,omitempty"`
}

// OrgInvitation represents a pending invitation to join an organization.
type OrgInvitation struct {
	ID        string     `json:"id"`
	OrgID     string     `json:"org_id"`
	Token     string     `json:"token"`
	Email     string     `json:"email,omitempty"`
	Role      string     `json:"role"` // default: "user"
	ExpiresAt time.Time  `json:"expires_at"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
}

// OrgSetting stores a single key-value pair scoped to an organization.
type OrgSetting struct {
	OrgID string `json:"org_id"`
	Key   string `json:"key"`
	Value string `json:"value"`
}

// AccessPolicy controls unattended access for a peer device.
type AccessPolicy struct {
	PeerID            string `json:"peer_id"`
	UnattendedEnabled bool   `json:"unattended_enabled"`            // Whether unattended access is allowed
	PasswordHash      string `json:"-"`                             // bcrypt hash of unattended password
	PasswordSet       bool   `json:"password_set"`                  // Whether a password is configured (computed, not stored)
	ScheduleEnabled   bool   `json:"schedule_enabled"`              // Whether access schedule is active
	ScheduleDays      string `json:"schedule_days,omitempty"`       // Comma-separated days: "mon,tue,wed,thu,fri"
	ScheduleStartTime string `json:"schedule_start_time,omitempty"` // HH:MM (24h format)
	ScheduleEndTime   string `json:"schedule_end_time,omitempty"`   // HH:MM (24h format)
	ScheduleTimezone  string `json:"schedule_timezone,omitempty"`   // IANA timezone (e.g. "Europe/Warsaw")
	AllowedOperators  string `json:"allowed_operators,omitempty"`   // Comma-separated operator usernames (empty = all)
	UpdatedAt         string `json:"updated_at,omitempty"`
	UpdatedBy         string `json:"updated_by,omitempty"` // Admin/operator who last changed the policy
}

// OrgRole constants
const (
	OrgRoleOwner    = "owner"
	OrgRoleAdmin    = "admin"
	OrgRoleOperator = "operator"
	OrgRoleUser     = "user"
)

// OrgRoleLevel returns the numeric privilege level for an org-scoped role.
// Higher = more privileges. Used for role boundary enforcement.
func OrgRoleLevel(role string) int {
	switch role {
	case OrgRoleOwner:
		return 40
	case OrgRoleAdmin:
		return 30
	case OrgRoleOperator:
		return 20
	case OrgRoleUser:
		return 10
	default:
		return 0
	}
}

// OrgCanAssignRole checks whether a caller with callerOrgRole may assign targetOrgRole.
// Owner → any; Admin → operator, user; Operator/User → none.
func OrgCanAssignRole(callerOrgRole, targetOrgRole string) bool {
	switch callerOrgRole {
	case OrgRoleOwner:
		// Owner can assign admin, operator, user (not another owner — handled in API)
		return targetOrgRole == OrgRoleAdmin || targetOrgRole == OrgRoleOperator || targetOrgRole == OrgRoleUser
	case OrgRoleAdmin:
		return targetOrgRole == OrgRoleOperator || targetOrgRole == OrgRoleUser
	default:
		return false
	}
}

// ValidOrgRole returns true if the given string is a recognized org role.
func ValidOrgRole(r string) bool {
	return r == OrgRoleOwner || r == OrgRoleAdmin || r == OrgRoleOperator || r == OrgRoleUser
}

// AuditConnection records a remote-control session event reported by a RustDesk client.
// Mirrors the Node.js console's audit_connections table for API-port consolidation.
type AuditConnection struct {
	ID        int64  `json:"id"`
	HostID    string `json:"host_id"`
	HostUUID  string `json:"host_uuid"`
	PeerID    string `json:"peer_id"`
	PeerName  string `json:"peer_name"`
	Action    string `json:"action"`
	ConnType  int    `json:"conn_type"`
	SessionID string `json:"session_id"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
}

// AuditFile records a file-transfer event reported by a RustDesk client.
type AuditFile struct {
	ID        int64  `json:"id"`
	HostID    string `json:"host_id"`
	HostUUID  string `json:"host_uuid"`
	PeerID    string `json:"peer_id"`
	Direction int    `json:"direction"`
	Path      string `json:"path"`
	IsFile    int    `json:"is_file"`
	NumFiles  int    `json:"num_files"`
	FilesJSON string `json:"files_json"`
	IP        string `json:"ip"`
	PeerName  string `json:"peer_name"`
	CreatedAt string `json:"created_at"`
}

// AuditAlarm records a security alarm event reported by a RustDesk client.
type AuditAlarm struct {
	ID        int64  `json:"id"`
	AlarmType int    `json:"alarm_type"`
	AlarmName string `json:"alarm_name"`
	HostID    string `json:"host_id"`
	PeerID    string `json:"peer_id"`
	IP        string `json:"ip"`
	Details   string `json:"details"`
	CreatedAt string `json:"created_at"`
}

// AuditFilter holds optional filter parameters for audit list/count queries.
// A nil AlarmType means "no filter on alarm_type".
type AuditFilter struct {
	HostID    string
	PeerID    string
	Action    string
	AlarmType *int
	Limit     int
	Offset    int
}

// UserGroup represents a named group of operator/user accounts.
// Mirrors the Node.js console's user_groups table.
type UserGroup struct {
	ID          int64  `json:"id"`
	GUID        string `json:"guid"`
	Name        string `json:"name"`
	Note        string `json:"note"`
	TeamID      string `json:"team_id"`
	MemberCount int    `json:"member_count"`
	CreatedAt   string `json:"created_at"`
}

// DeviceGroup represents a named group of devices.
// Mirrors the Node.js console's device_groups table.
type DeviceGroup struct {
	ID          int64  `json:"id"`
	GUID        string `json:"guid"`
	Name        string `json:"name"`
	Note        string `json:"note"`
	TeamID      string `json:"team_id"`
	SourceType  string `json:"source_type"` // "manual" or "tag"
	TagFilter   string `json:"tag_filter"`
	MemberCount int    `json:"member_count"`
	CreatedAt   string `json:"created_at"`
}

// Strategy maps a user group + device group to a permission policy.
// Mirrors the Node.js console's strategies table.
type Strategy struct {
	ID              int64  `json:"id"`
	GUID            string `json:"guid"`
	Name            string `json:"name"`
	UserGroupGUID   string `json:"user_group_guid"`
	DeviceGroupGUID string `json:"device_group_guid"`
	Enabled         bool   `json:"enabled"`
	Permissions     string `json:"permissions"` // JSON blob
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

// Database is the interface for all database operations.
// Designed to support SQLite (now) and PostgreSQL (future) as drop-in implementations.
type Database interface {
	// Lifecycle
	Close() error
	Migrate() error

	// Peer operations
	GetPeer(id string) (*Peer, error)
	// GetPeersByIDs returns active (non-soft-deleted) peers for the given IDs.
	// Missing IDs are omitted; an empty ids slice returns an empty map.
	GetPeersByIDs(ids []string) (map[string]*Peer, error)
	GetPeerByUUID(uuid string) (*Peer, error)
	UpsertPeer(p *Peer) error
	DeletePeer(id string) error     // soft delete
	HardDeletePeer(id string) error // permanent delete
	ListPeers(includeDeleted bool) ([]*Peer, error)
	// ListPeersPaginated returns peers with SQL LIMIT/OFFSET plus total row count.
	// limit <= 0 returns all rows (offset still applied).
	ListPeersPaginated(includeDeleted bool, limit, offset int) ([]*Peer, int, error)
	GetPeerCount() (total int, online int, err error)
	GetBannedPeerCount() (int, error)

	// Status tracking
	UpdatePeerStatus(id string, status string, ip string) error
	BatchUpdatePeerStatus(ids []string, status string) error
	UpdatePeerSysinfo(id, hostname, os, version string) error
	SetAllOffline() error

	// Peer field updates
	UpdatePeerFields(id string, fields map[string]string) error

	// Ban system
	BanPeer(id string, reason string) error
	UnbanPeer(id string) error
	IsPeerBanned(id string) (bool, error)
	IsPeerSoftDeleted(id string) (bool, error)
	// RestorePeer clears the soft_deleted flag and deleted_at timestamp,
	// making a previously deleted peer visible and registrable again.
	// This is an explicit admin operation — UpsertPeer must NOT do this
	// implicitly (GHSA-3v82-3gf8-fxx8).
	RestorePeer(id string) error

	// ID change
	ChangePeerID(oldID, newID string) error
	GetIDChangeHistory(id string) ([]*IDChangeHistory, error)
	// IsRenamedPeerID returns true if the given ID was previously used and
	// changed to a different one (appears as old_id in id_change_history).
	IsRenamedPeerID(id string) (bool, error)

	// CDAP: linked device queries
	GetLinkedPeers(id string) ([]*Peer, error)

	// Tags
	UpdatePeerTags(id, tags string) error
	ListPeersByTag(tag string) ([]*Peer, error)

	// Config
	GetConfig(key string) (string, error)
	SetConfig(key, value string) error
	DeleteConfig(key string) error
	ListConfigByPrefix(prefix string) ([]ServerConfig, error)

	// Users
	CreateUser(u *User) error
	GetUser(username string) (*User, error)
	GetUserByID(id int64) (*User, error)
	ListUsers() ([]*User, error)
	UpdateUser(u *User) error
	DeleteUser(id int64) error
	UpdateUserLogin(id int64) error
	UserCount() (int, error)

	// API Keys
	CreateAPIKey(k *APIKey) error
	GetAPIKeyByHash(keyHash string) (*APIKey, error)
	ListAPIKeys() ([]*APIKey, error)
	DeleteAPIKey(id int64) error
	TouchAPIKey(id int64) error

	// Device Tokens (Dual Key System)
	CreateDeviceToken(t *DeviceToken) error
	GetDeviceToken(id int64) (*DeviceToken, error)
	GetDeviceTokenByHash(tokenHash string) (*DeviceToken, error)
	GetDeviceTokenByPeerID(peerID string) (*DeviceToken, error)
	ListDeviceTokens(includeRevoked bool) ([]*DeviceToken, error)
	UpdateDeviceToken(t *DeviceToken) error
	RevokeDeviceToken(id int64) error
	BindTokenToPeer(tokenHash, peerID string) error
	IncrementTokenUse(tokenHash string) error
	ValidateToken(tokenHash string) (*DeviceToken, error) // Returns token if valid, nil if invalid/expired/revoked
	CleanupExpiredTokens() (int64, error)

	// Address Book
	GetAddressBook(username, abType string) (string, error) // Returns JSON data string; abType: "legacy" or "personal"
	SaveAddressBook(username, abType, data string) error

	// Peer Metrics (heartbeat CPU/memory/disk)
	SavePeerMetric(peerID string, cpu, memory, disk float64) error
	GetPeerMetrics(peerID string, limit int) ([]*PeerMetric, error)
	GetLatestPeerMetric(peerID string) (*PeerMetric, error)
	CleanupOldMetrics(maxAge time.Duration) (int64, error) // Delete metrics older than maxAge

	// Chat Messages
	SaveChatMessage(msg *ChatMessage) (int64, error) // Returns inserted ID
	GetChatHistory(conversationID string, limit int) ([]*ChatMessage, error)
	GetChatHistoryBefore(conversationID string, beforeID int64, limit int) ([]*ChatMessage, error)
	MarkChatRead(conversationID, readerID string) error // Mark all messages as read for reader
	GetUnreadCount(deviceID string) (int, error)        // Total unread messages for device
	DeleteChatHistory(conversationID string) error

	// Chat Groups
	CreateChatGroup(g *ChatGroup) error
	GetChatGroup(id string) (*ChatGroup, error)
	ListChatGroups(memberID string) ([]*ChatGroup, error) // Groups containing memberID
	UpdateChatGroup(g *ChatGroup) error
	DeleteChatGroup(id string) error

	// Help Requests
	CreateHelpRequest(r *HelpRequest) (int64, error) // Returns inserted ID
	GetHelpRequest(id int64) (*HelpRequest, error)
	ListHelpRequests(filter HelpRequestFilter) ([]*HelpRequest, error)
	UpdateHelpRequestStatus(id int64, status, handledBy string) error
	PruneHelpRequests(maxAge time.Duration) (int64, error) // Delete requests older than maxAge
	GetDeviceOrgID(deviceID string) (string, error)        // "" if device has no org

	// Organizations
	CreateOrganization(o *Organization) error
	GetOrganization(id string) (*Organization, error)
	GetOrganizationBySlug(slug string) (*Organization, error)
	ListOrganizations() ([]*Organization, error)
	UpdateOrganization(o *Organization) error
	DeleteOrganization(id string) error

	// Org Users
	CreateOrgUser(u *OrgUser) error
	GetOrgUser(id string) (*OrgUser, error)
	GetOrgUserByUsername(orgID, username string) (*OrgUser, error)
	GetOrgUserByServerUserID(orgID string, serverUserID int64) (*OrgUser, error)
	ListOrgUsers(orgID string) ([]*OrgUser, error)
	UpdateOrgUser(u *OrgUser) error
	DeleteOrgUser(id string) error
	UpdateOrgUserLogin(id string) error

	// Org User Linking (Issue #106)
	LinkUserToOrg(orgID string, userID int64, role string) (*OrgUser, error)
	UnlinkUserFromOrg(orgID string, serverUserID int64) error
	ListUsersNotInOrg(orgID string) ([]*User, error)
	ListUserOrganizations(userID int64) ([]*Organization, error)

	// Org Devices
	AssignDeviceToOrg(d *OrgDevice) error
	UnassignDeviceFromOrg(orgID, deviceID string) error
	GetOrgDevice(orgID, deviceID string) (*OrgDevice, error)
	ListOrgDevices(orgID string) ([]*OrgDevice, error)
	UpdateOrgDevice(d *OrgDevice) error

	// Org Invitations
	CreateOrgInvitation(inv *OrgInvitation) error
	GetOrgInvitationByToken(token string) (*OrgInvitation, error)
	ListOrgInvitations(orgID string) ([]*OrgInvitation, error)
	UseOrgInvitation(token string) error
	DeleteOrgInvitation(id string) error

	// Org Settings
	GetOrgSetting(orgID, key string) (string, error)
	SetOrgSetting(orgID, key, value string) error
	DeleteOrgSetting(orgID, key string) error
	ListOrgSettings(orgID string) ([]*OrgSetting, error)

	// Org Address Books (shared contacts for organization members)
	GetOrgAddressBook(orgID, abType string) (string, error)
	SaveOrgAddressBook(orgID, abType, data, updatedBy string) error

	// Access Policies (unattended access management)
	GetAccessPolicy(peerID string) (*AccessPolicy, error)
	SaveAccessPolicy(p *AccessPolicy) error
	DeleteAccessPolicy(peerID string) error

	// Role Permissions (RBAC Phase 52)
	ListRolePermissions(role string) ([]*RolePermission, error)
	SetRolePermission(role, permission string, granted bool) error
	DeleteRolePermission(role, permission string) error
	HasRolePermission(role, permission string) (bool, error)

	// Org-scoped device queries (RBAC Phase 52 — data scoping)
	ListPeersForOrg(orgID string, includeDeleted bool) ([]*Peer, error)
	ListPeersForOrgPaginated(orgID string, includeDeleted bool, limit, offset int) ([]*Peer, int, error)

	// Audit logs (RustDesk client reporting — API-port consolidation Phase A)
	InsertAuditConnection(a *AuditConnection) error
	ListAuditConnections(f AuditFilter) ([]*AuditConnection, error)
	CountAuditConnections(f AuditFilter) (int, error)
	InsertAuditFile(a *AuditFile) error
	ListAuditFiles(f AuditFilter) ([]*AuditFile, error)
	CountAuditFiles(f AuditFilter) (int, error)
	InsertAuditAlarm(a *AuditAlarm) error
	ListAuditAlarms(f AuditFilter) ([]*AuditAlarm, error)
	CountAuditAlarms(f AuditFilter) (int, error)

	// User groups (operator/user grouping — API-port consolidation Phase A)
	ListUserGroups() ([]*UserGroup, error)
	GetUserGroup(guid string) (*UserGroup, error)
	CreateUserGroup(g *UserGroup) error
	UpdateUserGroup(guid string, g *UserGroup) error
	DeleteUserGroup(guid string) error

	// Device groups (device grouping — API-port consolidation Phase A)
	ListDeviceGroups() ([]*DeviceGroup, error)
	GetDeviceGroup(guid string) (*DeviceGroup, error)
	CreateDeviceGroup(g *DeviceGroup) error
	UpdateDeviceGroup(guid string, g *DeviceGroup) error
	DeleteDeviceGroup(guid string) error

	// Strategies (permission policies — API-port consolidation Phase A)
	ListStrategies() ([]*Strategy, error)
	GetStrategy(guid string) (*Strategy, error)
	CreateStrategy(s *Strategy) error
	UpdateStrategy(guid string, s *Strategy) error
	DeleteStrategy(guid string) error

	// Billing / commercialization
	CreateBillingPackage(p *BillingPackage) error
	GetBillingPackage(id string) (*BillingPackage, error)
	ListBillingPackages() ([]*BillingPackage, error)
	UpdateBillingPackage(p *BillingPackage) error
	DeleteBillingPackage(id string) error

	CreateBillingOrgContract(c *BillingOrgContract) error
	GetBillingOrgContract(id string) (*BillingOrgContract, error)
	GetActiveBillingOrgContract(orgID string) (*BillingOrgContract, error)
	ListBillingOrgContracts(filter BillingContractFilter) ([]*BillingOrgContract, error)
	UpdateBillingOrgContract(c *BillingOrgContract) error

	CreateBillingSession(s *BillingSession) error
	GetBillingSession(id string) (*BillingSession, error)
	GetBillingSessionByRelayUUID(relayUUID string) (*BillingSession, error)
	UpdateBillingSession(s *BillingSession) error
	ListBillingSessions(filter BillingSessionFilter) ([]*BillingSession, error)

	InsertBillingLedgerEntry(e *BillingSessionLedger) error
	ListBillingLedger(sessionID string) ([]*BillingSessionLedger, error)

	CreateBillingWorkReport(r *BillingWorkReport) error
	GetBillingWorkReportBySession(sessionID string) (*BillingWorkReport, error)
	ListBillingWorkReports(orgID string, limit int) ([]*BillingWorkReport, error)

	ListBillingCurrencies() ([]*BillingCurrency, error)
	UpsertBillingCurrency(c *BillingCurrency) error
	DeleteBillingCurrency(code string) error
}
