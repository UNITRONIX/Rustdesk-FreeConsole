package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/crypto/peervault"
	"github.com/unitronix/betterdesk-server/db"
)

func TestStripSecretsFromOrgAddressBook(t *testing.T) {
	in := `{"peers":[{"id":"123456","alias":"A","password":"secret","hash":"h1"}],"tags":[]}`
	out := stripSecretsFromOrgAddressBook(in)
	var ab map[string]any
	if err := json.Unmarshal([]byte(out), &ab); err != nil {
		t.Fatal(err)
	}
	peers := ab["peers"].([]any)
	p := peers[0].(map[string]any)
	if _, ok := p["password"]; ok {
		t.Fatal("password should be stripped")
	}
	if _, ok := p["hash"]; ok {
		t.Fatal("hash should be stripped")
	}
	if p["alias"] != "A" {
		t.Fatalf("alias lost: %v", p["alias"])
	}
}

func TestInjectOrgPeerCredentialsIntoAB(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	org := &db.Organization{ID: "org-vault", Name: "Vault Org", Slug: "vault-org", CreatedAt: time.Now().UTC()}
	if err := database.CreateOrganization(org); err != nil {
		t.Fatal(err)
	}
	user := &db.User{Username: "op1", PasswordHash: "x", Role: "operator"}
	if err := database.CreateUser(user); err != nil {
		t.Fatal(err)
	}
	if _, err := database.LinkUserToOrg(org.ID, user.ID, db.OrgRoleOperator); err != nil {
		t.Fatal(err)
	}
	_ = database.SetOrgSetting(org.ID, orgSharedAddressBookEnabledKey, "true")

	v, err := peervault.New("test-secret-at-least-16b")
	if err != nil {
		t.Fatal(err)
	}
	n, c, kid, err := v.Seal("lab-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SaveOrgPeerCredential(&db.OrgPeerCredential{
		OrgID: org.ID, PeerID: "123456789", Ciphertext: c, Nonce: n, KeyID: kid, UpdatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}

	s := &Server{db: database, peerVault: v}
	req := httptest.NewRequest(http.MethodGet, "/api/ab", nil)
	ctx := context.WithValue(req.Context(), ctxKeyUsername, "op1")
	ctx = context.WithValue(ctx, ctxKeyRole, "operator")
	ctx = context.WithValue(ctx, ctxKeyUser, user)
	req = req.WithContext(ctx)

	base := `{"peers":[{"id":"123456789","alias":"Lab"}],"tags":[]}`
	out := s.injectOrgPeerCredentialsIntoAB(req, base)
	var ab map[string]any
	if err := json.Unmarshal([]byte(out), &ab); err != nil {
		t.Fatal(err)
	}
	p := ab["peers"].([]any)[0].(map[string]any)
	if p["password"] != "lab-password" {
		t.Fatalf("expected injected password, got %#v", p["password"])
	}

	persisted := stripSecretsFromOrgAddressBook(out)
	var ab2 map[string]any
	_ = json.Unmarshal([]byte(persisted), &ab2)
	p2 := ab2["peers"].([]any)[0].(map[string]any)
	if _, ok := p2["password"]; ok {
		t.Fatal("stripped AB still has password")
	}
}
