package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	servercrypto "github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/sessiongrant"
)

func TestIssueSupportSessionGrantBindsOperatorDeviceAndTransport(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	if err := database.UpsertPeer(&db.Peer{ID: "BD-12345", Status: "ONLINE", DeviceType: "os_agent"}); err != nil {
		t.Fatal(err)
	}
	keyPair, err := servercrypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	srv.SetKeyPair(keyPair)

	body := []byte(`{"session_id":"session-1","transport":"relay","capabilities":["screen_view","input"],"ttl_seconds":60}`)
	req := httptest.NewRequest(http.MethodPost, "/api/peers/BD-12345/session-grant", bytes.NewReader(body))
	req.SetPathValue("id", "BD-12345")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUsername, "operator-1"))
	rec := httptest.NewRecorder()

	srv.handleIssueSupportSessionGrant(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var response supportSessionGrantResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	claims, err := sessiongrant.Verify(response.Grant, keyPair.PublicKey, "BD-12345", "relay", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claims.OperatorID != "operator-1" || claims.SessionID != "session-1" || claims.Initiator != "operator" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestIssueSupportSessionGrantRejectsUnknownCapabilities(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	if err := database.UpsertPeer(&db.Peer{ID: "BD-12345", Status: "ONLINE", DeviceType: "os_agent"}); err != nil {
		t.Fatal(err)
	}
	keyPair, err := servercrypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	srv.SetKeyPair(keyPair)

	req := httptest.NewRequest(http.MethodPost, "/api/peers/BD-12345/session-grant",
		bytes.NewBufferString(`{"session_id":"session-1","transport":"relay","capabilities":["session_initiate"]}`))
	req.SetPathValue("id", "BD-12345")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUsername, "operator-1"))
	rec := httptest.NewRecorder()

	srv.handleIssueSupportSessionGrant(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestIssueSupportSessionGrantRejectsNegativeLifetime(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	if err := database.UpsertPeer(&db.Peer{ID: "BD-12345", Status: "ONLINE", DeviceType: "os_agent"}); err != nil {
		t.Fatal(err)
	}
	keyPair, err := servercrypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	srv.SetKeyPair(keyPair)
	req := httptest.NewRequest(http.MethodPost, "/api/peers/BD-12345/session-grant",
		bytes.NewBufferString(`{"session_id":"session-1","transport":"cdap","capabilities":["screen_view"],"ttl_seconds":-1}`))
	req.SetPathValue("id", "BD-12345")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUsername, "operator-1"))
	rec := httptest.NewRecorder()

	srv.handleIssueSupportSessionGrant(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}
