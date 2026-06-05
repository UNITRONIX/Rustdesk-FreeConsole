package auth

import "testing"

func TestProRoleHasNoDevicePermissions(t *testing.T) {
	devicePerms := []string{
		PermDeviceView, PermDeviceConnect, PermDeviceEdit,
		PermDeviceDelete, PermDeviceBan, PermDeviceChangeID,
	}
	for _, perm := range devicePerms {
		if RoleHasPermission(RolePro, perm) {
			t.Fatalf("pro role must not have %s", perm)
		}
	}
	if RoleHasPermission(RolePro, PermOrgManageDevices) {
		t.Fatal("pro role must not have org.manage_devices")
	}
}

func TestProRoleBlocksPermission(t *testing.T) {
	if !ProRoleBlocksPermission(PermDeviceView) {
		t.Fatal("device.view must be blocked for pro")
	}
	if ProRoleBlocksPermission(PermUserView) {
		t.Fatal("user.view must not be blocked for pro by default")
	}
}
