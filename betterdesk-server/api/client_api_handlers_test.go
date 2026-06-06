package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestNormalizeAbDataField(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   json.RawMessage
		want string
	}{
		{"empty", nil, "{}"},
		{"null", json.RawMessage("null"), "{}"},
		{"json string", json.RawMessage(`"{\"peers\":[]}"`), `{"peers":[]}`},
		{"object", json.RawMessage(`{"peers":[],"tags":[]}`), `{"peers":[],"tags":[]}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeAbDataField(tc.in); got != tc.want {
				t.Fatalf("normalizeAbDataField() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAbDataFieldPresent(t *testing.T) {
	t.Parallel()
	if abDataFieldPresent(nil) {
		t.Fatal("nil data should not be present")
	}
	if abDataFieldPresent(json.RawMessage("null")) {
		t.Fatal("null data should not be present")
	}
	if !abDataFieldPresent(json.RawMessage(`"{\"peers\":[]}"`)) {
		t.Fatal("non-empty data should be present")
	}
}

func TestDecodeClientAbPostBodyEmpty(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPost, "/api/ab/personal", nil)
	body, empty, err := decodeClientAbPostBody(req, "POST /api/ab/personal", "alice")
	if err != nil {
		t.Fatalf("decodeClientAbPostBody: %v", err)
	}
	if !empty {
		t.Fatal("expected emptyBody=true for Content-Length: 0")
	}
	if len(body.Data) != 0 {
		t.Fatalf("expected empty data field, got %q", body.Data)
	}
}

func TestDecodeClientAbPostBodyFlutterEnvelope(t *testing.T) {
	t.Parallel()
	payload := `{"data":"{\"peers\":[],\"tags\":[]}"}`
	req := httptest.NewRequest(http.MethodPost, "/api/ab", bytes.NewReader([]byte(payload)))
	body, empty, err := decodeClientAbPostBody(req, "POST /api/ab", "alice")
	if err != nil {
		t.Fatalf("decodeClientAbPostBody: %v", err)
	}
	if empty {
		t.Fatal("expected emptyBody=false")
	}
	if !abDataFieldPresent(body.Data) {
		t.Fatal("expected data field present")
	}
}

func withClientUser(r *http.Request, username, role string) *http.Request {
	ctx := context.WithValue(r.Context(), ctxKeyUsername, username)
	ctx = context.WithValue(ctx, ctxKeyRole, role)
	return r.WithContext(ctx)
}

func TestHandleClientAddressBookPersonalEmptyProbeReturns404(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodPost, "/api/ab/personal", nil)
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientAddressBookPersonal(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientAddressBookPersonalEmptyJSONProbeReturns404(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodPost, "/api/ab/personal", bytes.NewReader([]byte("{}")))
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientAddressBookPersonal(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientAddressBookEmptyPostSavesEmptyLegacyBook(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodPost, "/api/ab", nil)
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientAddressBook(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	data, err := database.GetAddressBook("alice", "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if data != "{}" {
		t.Fatalf("saved legacy AB = %q, want {}", data)
	}
}

func TestHandleClientAddressBookFlutterPush(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	inner, _ := json.Marshal(map[string]any{
		"peers": []map[string]any{{"id": "123456789", "tags": []string{"Home"}}},
		"tags":  []string{"Home"},
	})
	outer, _ := json.Marshal(map[string]string{"data": string(inner)})
	req := httptest.NewRequest(http.MethodPost, "/api/ab", bytes.NewReader(outer))
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientAddressBook(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	data, err := database.GetAddressBook("alice", "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains([]byte(data), []byte("123456789")) {
		t.Fatalf("saved AB missing peer id: %s", data)
	}
}

func TestHandleClientAddressBookGetReturnsStoredData(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	if err := database.SaveAddressBook("alice", "legacy", `{"peers":[],"tags":["Home"]}`); err != nil {
		t.Fatal(err)
	}

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodGet, "/api/ab", nil)
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientAddressBook(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	data, ok := resp["data"].(string)
	if !ok || data == "" {
		t.Fatalf("expected string data field, got %#v", resp["data"])
	}
}

func TestDecodeClientAbPostBodyInvalidJSON(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPost, "/api/ab", bytes.NewReader([]byte("{not-json")))
	_, _, err := decodeClientAbPostBody(req, "POST /api/ab", "alice")
	if err == nil {
		t.Fatal("expected decode error for invalid JSON")
	}
	if err == io.EOF {
		t.Fatal("expected syntax error, not EOF")
	}
}
