package auth

import "testing"

func TestIsSuperAdminRole(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{RoleSuperAdmin, true},
		{RoleAdmin, true},
		{RoleServerAdmin, false},
		{RoleGlobalAdmin, false},
		{RoleOperator, false},
	}
	for _, tt := range tests {
		if got := IsSuperAdminRole(tt.role); got != tt.want {
			t.Errorf("IsSuperAdminRole(%q) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

func TestCanAssignRole(t *testing.T) {
	tests := []struct {
		caller, target string
		want           bool
	}{
		{RoleSuperAdmin, RoleServerAdmin, true},
		{RoleAdmin, RoleGlobalAdmin, true},
		{RoleGlobalAdmin, RoleOperator, true},
		{RoleGlobalAdmin, RoleGlobalAdmin, false},
		{RoleGlobalAdmin, RoleSuperAdmin, false},
		{RoleServerAdmin, RoleViewer, false},
		{RoleOperator, RoleViewer, false},
	}
	for _, tt := range tests {
		if got := CanAssignRole(tt.caller, tt.target); got != tt.want {
			t.Errorf("CanAssignRole(%q, %q) = %v, want %v", tt.caller, tt.target, got, tt.want)
		}
	}
}
