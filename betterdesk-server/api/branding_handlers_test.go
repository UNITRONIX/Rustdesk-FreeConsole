package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestBrandingGetDefaultsAndSave(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	cfg.APIPort = 19890
	srv := New(cfg, database, peer.NewMap(), nil, "1.0.0-test")
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(80 * time.Millisecond)

	base := fmt.Sprintf("http://127.0.0.1:%d/api", cfg.APIPort)

	resp, err := http.Get(base + "/branding")
	if err != nil {
		t.Fatalf("GET /branding: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status %d", resp.StatusCode)
	}
	var got BrandingConfig
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != brandingSchemaVersion {
		t.Fatalf("schema_version=%d", got.SchemaVersion)
	}
	if got.CompanyName != "BetterDesk" {
		t.Fatalf("company=%q", got.CompanyName)
	}
	if len(got.Profiles.BetterDesk.Apply) == 0 {
		t.Fatal("expected betterdesk apply list")
	}

	png1x1 := base64.StdEncoding.EncodeToString([]byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
		0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
		0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	})
	body := map[string]any{
		"company_name":    "Acme Corp",
		"phone":           "+48 111",
		"email":           "help@acme.example",
		"website":         "https://acme.example",
		"accent_color":    "#112233",
		"support_contact": "Desk",
		"logo": map[string]string{
			"mime":         "image/png",
			"data_base64":  png1x1,
		},
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, base+"/branding", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req = testAuthReq(req)
	saveResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer saveResp.Body.Close()
	if saveResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(saveResp.Body)
		t.Fatalf("POST status %d body=%s", saveResp.StatusCode, string(b))
	}

	resp2, err := http.Get(base + "/branding")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var got2 BrandingConfig
	if err := json.NewDecoder(resp2.Body).Decode(&got2); err != nil {
		t.Fatal(err)
	}
	if got2.CompanyName != "Acme Corp" || got2.Phone != "+48 111" || got2.Email != "help@acme.example" {
		t.Fatalf("unexpected branding: %+v", got2)
	}
	if got2.Revision == "" || got2.Revision == "0" {
		t.Fatal("expected non-zero revision")
	}
	if got2.Logo == nil || got2.Logo.DataBase64 == "" {
		t.Fatal("expected logo payload")
	}
	if got2.Profiles.RustDesk.ConfigOptions["display-name"] != "Acme Corp" {
		t.Fatalf("rustdesk profile: %+v", got2.Profiles.RustDesk)
	}
}

func TestValidateAccentAndLogo(t *testing.T) {
	t.Parallel()
	if err := validateAccentColor("#abc"); err != nil {
		t.Fatal(err)
	}
	if err := validateAccentColor("red"); err == nil {
		t.Fatal("expected invalid color")
	}
	bad := &BrandingLogo{Mime: "image/gif", DataBase64: base64.StdEncoding.EncodeToString([]byte("x"))}
	if err := validateBrandingLogo(bad); err == nil {
		t.Fatal("expected gif rejected")
	}
}
