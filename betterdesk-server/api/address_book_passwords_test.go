package api

import (
	"testing"

	"github.com/unitronix/betterdesk-server/db"
)

func TestAccessPolicyEligibleForABPassword(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		policy *db.AccessPolicy
		want   bool
	}{
		{name: "nil", policy: nil, want: false},
		{
			name: "ready",
			policy: &db.AccessPolicy{
				UnattendedEnabled:        true,
				PasswordlessServerAccess: true,
				PasswordEnc:              "sealed",
			},
			want: true,
		},
		{
			name: "unattended off",
			policy: &db.AccessPolicy{
				UnattendedEnabled:        false,
				PasswordlessServerAccess: true,
				PasswordEnc:              "sealed",
			},
			want: false,
		},
		{
			name: "passwordless off",
			policy: &db.AccessPolicy{
				UnattendedEnabled:        true,
				PasswordlessServerAccess: false,
				PasswordEnc:              "sealed",
			},
			want: false,
		},
		{
			name: "no sealed secret",
			policy: &db.AccessPolicy{
				UnattendedEnabled:        true,
				PasswordlessServerAccess: true,
				PasswordEnc:              "",
			},
			want: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := accessPolicyEligibleForABPassword(tc.policy); got != tc.want {
				t.Fatalf("accessPolicyEligibleForABPassword() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestOperatorAllowedForAccessPolicy(t *testing.T) {
	t.Parallel()

	if !operatorAllowedForAccessPolicy("alice", "") {
		t.Fatal("empty allow-list should allow everyone")
	}
	if !operatorAllowedForAccessPolicy("apikey:panel", "bob") {
		t.Fatal("apikey callers should bypass allow-list")
	}
	if !operatorAllowedForAccessPolicy("Alice", "bob, alice") {
		t.Fatal("case-insensitive match expected")
	}
	if operatorAllowedForAccessPolicy("eve", "bob, alice") {
		t.Fatal("non-listed operator must be denied")
	}
}

func TestInjectPeerPasswordsIntoAddressBook(t *testing.T) {
	t.Parallel()

	data := `{"peers":[{"id":"111","alias":"A","password":"old"},{"id":"222","alias":"B"}],"tags":[]}`
	got := injectPeerPasswordsIntoAddressBook(data, map[string]string{
		"111": "policy-secret",
		"999": "unused",
	})
	ab := parseAddressBookMap(got)
	peers := toPeerSlice(ab["peers"])
	byID := map[string]map[string]any{}
	for _, p := range peers {
		byID[p["id"].(string)] = p
	}
	if byID["111"]["password"] != "policy-secret" {
		t.Fatalf("passwordless inject should overwrite AB password, got %v", byID["111"]["password"])
	}
	if _, ok := byID["222"]["password"]; ok {
		t.Fatalf("peer without policy password should stay unchanged, got %v", byID["222"]["password"])
	}

	if unchanged := injectPeerPasswordsIntoAddressBook(data, nil); unchanged != data {
		t.Fatalf("empty map should leave data unchanged")
	}
}
