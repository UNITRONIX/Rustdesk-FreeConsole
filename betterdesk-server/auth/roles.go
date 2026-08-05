package auth

// Server-level role constants (global scope).
//
// Hierarchy (branched — not strictly linear):
//
//	super_admin      — full server + all-org access, manages other super admins
//	├── server_admin — server config/logs/integrations, read-only user visibility
//	├── global_admin — all-org user/device management, no server access
//	└── (legacy) admin/operator/viewer/pro — kept for backward compatibility
const (
	// New 6-tier roles (Discussion #99)
	RoleSuperAdmin  = "super_admin"
	RoleServerAdmin = "server_admin"
	RoleGlobalAdmin = "global_admin"

	// Legacy global roles (backward-compatible)
	RoleAdmin    = "admin" // maps to super_admin in permission terms
	RoleOperator = "operator"
	RoleViewer   = "viewer"
	RolePro      = "pro" // API-only RustDesk PRO activation; no device access

	// RoleDevice is an internal, device-scoped principal used for authenticated
	// agents. It is intentionally not a user-assignable role.
	RoleDevice = "device"
)

// RoleLevel returns the numeric privilege level for a role.
// Higher = more privileges. server_admin and global_admin share level 4
// but have DIFFERENT permission sets — use RoleHasPermission for checks.
func RoleLevel(role string) int {
	switch role {
	case RoleSuperAdmin:
		return 5
	case RoleServerAdmin, RoleGlobalAdmin:
		return 4
	case RoleAdmin: // legacy admin ≈ super_admin
		return 5
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	case RolePro:
		return 0
	case RoleDevice:
		return 0
	default:
		return 0
	}
}

// IsSuperAdminRole returns true for super_admin and legacy admin.
func IsSuperAdminRole(role string) bool {
	return role == RoleSuperAdmin || role == RoleAdmin
}

// IsServerLevel returns true for any server-level elevated role.
func IsServerLevel(role string) bool {
	return role == RoleSuperAdmin || role == RoleAdmin ||
		role == RoleServerAdmin || role == RoleGlobalAdmin
}

// CanAssignRole checks whether a user with callerRole may assign targetRole.
// Implements the role assignment boundary rules from Discussion #99.
func CanAssignRole(callerRole, targetRole string) bool {
	switch {
	// Super Admin (and legacy admin) can assign ANY role
	case IsSuperAdminRole(callerRole):
		return true

	// Global Admin can assign roles below global_admin
	// (operator, viewer, pro — NOT super_admin, server_admin, global_admin, admin)
	case callerRole == RoleGlobalAdmin:
		return targetRole == RoleOperator || targetRole == RoleViewer || targetRole == RolePro

	// Server Admin cannot assign any roles
	case callerRole == RoleServerAdmin:
		return false

	// Operator, viewer, pro cannot assign any roles
	default:
		return false
	}
}

// HasPermission returns true if userRole has at least the privileges of requiredRole.
// Kept for backward compatibility — prefer requirePermission middleware.
func HasPermission(userRole, requiredRole string) bool {
	// A device credential must never satisfy a user-role check merely because
	// both roles have the same numeric level.
	if IsDeviceRole(userRole) {
		return userRole == requiredRole
	}
	return RoleLevel(userRole) >= RoleLevel(requiredRole)
}

// IsDeviceRole reports whether role is the internal device-only principal.
func IsDeviceRole(role string) bool {
	return role == RoleDevice
}

// ValidRole returns true if the given string is a recognised role.
func ValidRole(r string) bool {
	switch r {
	case RoleSuperAdmin, RoleServerAdmin, RoleGlobalAdmin,
		RoleAdmin, RoleOperator, RoleViewer, RolePro:
		return true
	}
	return false
}
