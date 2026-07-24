// Package auth — granular permission system for RBAC (Phase 52).
//
// Each permission is a dot-separated action string: "resource.action".
// Roles map to a set of granted permissions via DefaultRolePermissions.
// Custom overrides are stored in the role_permissions DB table.
package auth

import "strings"

// Permission constants define every discrete action in the system.
const (
	// Device permissions
	PermDeviceView     = "device.view"
	PermDeviceConnect  = "device.connect"
	PermDeviceEdit     = "device.edit"   // notes, tags, display name
	PermDeviceDelete   = "device.delete" // soft-delete + revoke
	PermDeviceBan      = "device.ban"    // ban/unban
	PermDeviceChangeID = "device.change_id"

	// User management permissions
	PermUserView   = "user.view"
	PermUserCreate = "user.create"
	PermUserEdit   = "user.edit"
	PermUserDelete = "user.delete"

	// Server configuration
	PermServerConfig     = "server.config"     // read/write server_config
	PermServerKeys       = "server.keys"       // manage API keys
	PermServerAttestation = "server.attestation" // run/view server performance attestation

	// Organization permissions
	PermOrgCreate        = "org.create"
	PermOrgEdit          = "org.edit"
	PermOrgDelete        = "org.delete"
	PermOrgManageUsers   = "org.manage_users"
	PermOrgManageDevices = "org.manage_devices"

	// Audit + monitoring
	PermAuditView     = "audit.view"
	PermMetricsView   = "metrics.view"
	PermBlocklistEdit = "blocklist.edit"

	// CDAP
	PermCDAPView     = "cdap.view"
	PermCDAPCommand  = "cdap.command"
	PermCDAPTerminal = "cdap.terminal"
	PermCDAPFiles    = "cdap.files"

	// MeshCentral compatibility (BetterCore / MeshAgent)
	PermMeshTerminal = "mesh.terminal"
	PermMeshFiles    = "mesh.files"
	PermMeshPower    = "mesh.power"

	// Enrollment
	PermEnrollmentManage  = "enrollment.manage"
	PermEnrollmentApprove = "enrollment.approve"

	// Chat
	PermChatAccess = "chat.access"

	// Branding
	PermBrandingEdit = "branding.edit"

	// Billing / commercialization
	PermBillingView   = "billing.view"
	PermBillingManage = "billing.manage"
	PermBillingReports = "billing.reports"
	PermBillingExport = "billing.export"
)

// AllPermissions is the complete list of permission strings for validation.
var AllPermissions = []string{
	PermDeviceView, PermDeviceConnect, PermDeviceEdit, PermDeviceDelete,
	PermDeviceBan, PermDeviceChangeID,
	PermUserView, PermUserCreate, PermUserEdit, PermUserDelete,
	PermServerConfig, PermServerKeys, PermServerAttestation,
	PermOrgCreate, PermOrgEdit, PermOrgDelete, PermOrgManageUsers, PermOrgManageDevices,
	PermAuditView, PermMetricsView, PermBlocklistEdit,
	PermCDAPView, PermCDAPCommand, PermCDAPTerminal, PermCDAPFiles,
	PermMeshTerminal, PermMeshFiles, PermMeshPower,
	PermEnrollmentManage, PermEnrollmentApprove,
	PermChatAccess,
	PermBrandingEdit,
	PermBillingView, PermBillingManage, PermBillingReports, PermBillingExport,
}

// DefaultRolePermissions maps each built-in role to its default set of permissions.
// Custom overrides from the DB take precedence.
//
// Role scoping (Discussion #99):
//   super_admin  — all permissions, manages other super admins
//   server_admin — server infrastructure only, read-only user list
//   global_admin — all-org user/device/org management, NO server access
//   admin        — legacy alias, equivalent to super_admin
//   operator     — day-to-day device ops + chat
//   viewer       — read-only dashboards
//   pro          — API-only RustDesk PRO activation; no device or org device access
var DefaultRolePermissions = map[string]map[string]bool{
	RoleSuperAdmin: buildPermMap(AllPermissions),
	RoleAdmin:      buildPermMap(AllPermissions), // legacy admin = super_admin

	// Server Admin: infrastructure + monitoring, read-only user visibility.
	// Cannot create/edit/delete users, cannot manage orgs.
	RoleServerAdmin: buildPermMap([]string{
		PermServerConfig, PermServerKeys, PermServerAttestation,
		PermBlocklistEdit,
		PermUserView,   // read-only
		PermDeviceView, // read-only
		PermAuditView,
		PermMetricsView,
		PermEnrollmentManage,
	}),

	// Global Admin: all user/org management, NO server config/keys.
	RoleGlobalAdmin: buildPermMap([]string{
		PermUserView, PermUserCreate, PermUserEdit, PermUserDelete,
		PermOrgCreate, PermOrgEdit, PermOrgDelete, PermOrgManageUsers, PermOrgManageDevices,
		PermDeviceView, PermDeviceConnect, PermDeviceEdit, PermDeviceDelete,
		PermDeviceBan, PermDeviceChangeID,
		PermAuditView, PermMetricsView,
		PermCDAPView, PermCDAPCommand, PermCDAPTerminal, PermCDAPFiles,
		PermMeshTerminal, PermMeshFiles, PermMeshPower,
		PermChatAccess,
		PermEnrollmentManage, PermEnrollmentApprove,
		PermBrandingEdit,
		PermBillingView, PermBillingManage, PermBillingReports, PermBillingExport,
	}),

	RoleOperator: buildPermMap([]string{
		PermDeviceView, PermDeviceConnect, PermDeviceEdit,
		PermUserView,
		PermAuditView, PermMetricsView,
		PermCDAPView, PermCDAPCommand,
		PermMeshPower,
		PermChatAccess,
		PermOrgManageDevices,
		PermBillingView, PermBillingReports,
	}),
	RoleViewer: buildPermMap([]string{
		PermDeviceView,
		PermAuditView, PermMetricsView,
		PermCDAPView,
		PermChatAccess,
	}),
	RolePro: buildPermMap([]string{}),
}

// buildPermMap converts a slice of permission strings into a lookup map.
func buildPermMap(perms []string) map[string]bool {
	m := make(map[string]bool, len(perms))
	for _, p := range perms {
		m[p] = true
	}
	return m
}

// IsProRole returns true for the API-only RustDesk PRO activation role.
func IsProRole(role string) bool {
	return role == RolePro
}

// ProRoleBlocksPermission reports permissions the pro role must never hold,
// even via DB overrides (device inventory and org device assignment).
func ProRoleBlocksPermission(permission string) bool {
	return strings.HasPrefix(permission, "device.") || permission == PermOrgManageDevices
}

// RoleHasPermission checks whether a role (by name) has a specific permission
// according to default role mappings. Returns true for super_admin and legacy admin.
// For DB-overridden permissions, use the Database.HasRolePermission method instead.
func RoleHasPermission(role, permission string) bool {
	if IsProRole(role) && ProRoleBlocksPermission(permission) {
		return false
	}
	if IsSuperAdminRole(role) {
		return true
	}
	perms, ok := DefaultRolePermissions[role]
	if !ok {
		return false
	}
	return perms[permission]
}

// ValidPermission returns true if the given string is a recognized permission.
func ValidPermission(p string) bool {
	for _, v := range AllPermissions {
		if v == p {
			return true
		}
	}
	return false
}
