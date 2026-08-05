package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestDeviceJWTCannotAccessOperatorAPIHandlers(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	jwtManager := auth.NewJWTManager("device-role-test-secret", time.Hour)
	srv.SetJWTManager(jwtManager)

	token, err := jwtManager.Generate("device:AGENT001", auth.RoleDevice)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	handler := srv.authMiddleware(srv.requireRole(auth.RoleOperator, func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/peers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("device-scoped JWT reached an operator API handler")
	}
}

func TestDeviceSelfServiceRequiresActiveBoundToken(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	if err := database.UpsertPeer(&db.Peer{ID: "AGENT001", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")

	const pendingToken = "pending-enrollment-token-0123456789"
	pendingHash := sha256.Sum256([]byte(pendingToken))
	if err := database.CreateDeviceToken(&db.DeviceToken{
		Token:     pendingToken,
		TokenHash: hex.EncodeToString(pendingHash[:]),
		Name:      "pending enrollment",
		Status:    db.TokenStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok := deviceTokenPeerID(srv, "AGENT001", pendingToken); ok {
		t.Fatal("unbound pending enrollment token authenticated a device self-service request")
	}

	boundToken, err := srv.issueEnrollmentDeviceToken("AGENT001")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := deviceTokenPeerID(srv, "AGENT001", boundToken); !ok {
		t.Fatal("active token bound to its device was rejected")
	}
	if _, ok := deviceTokenPeerID(srv, "OTHER001", boundToken); ok {
		t.Fatal("device token authenticated a different device")
	}
}
