package api

import (
	"testing"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

func TestPanelAccessAllowed(t *testing.T) {
	user := &db.User{Username: "operator1", Role: auth.RoleOperator}
	guids := map[string]bool{"ug-1": true}

	if !panelAccessAllowed(user, auth.RoleOperator, guids, nil, nil) {
		t.Fatal("expected open group for operator")
	}
	if panelAccessAllowed(user, auth.RoleOperator, guids, []string{"other"}, nil) {
		t.Fatal("expected deny when username not in allowed_users")
	}
	if !panelAccessAllowed(user, auth.RoleOperator, guids, nil, []string{"ug-1"}) {
		t.Fatal("expected allow via user group membership")
	}
	if !panelAccessAllowed(user, auth.RoleGlobalAdmin, guids, []string{"x"}, nil) {
		t.Fatal("expected global_admin bypass")
	}
}
