package api

import (
	"testing"

	"github.com/unitronix/betterdesk-server/db"
)

func TestRustDeskCardFields_panelDisplayNameBecomesAlias(t *testing.T) {
	t.Parallel()

	p := &db.Peer{
		ID:          "1031876693",
		Hostname:    "dcstrainingserver01",
		User:        "admin",
		DisplayName: "Training",
		Note:        "Training",
	}
	alias, note, host, user := rustDeskCardFields(p, "", "", p.Hostname, p.User)
	if alias != "Training" {
		t.Fatalf("alias=%q, want Training", alias)
	}
	if note != "1031876693" {
		t.Fatalf("note should be peer ID under display name, got %q", note)
	}
	if host != "" || user != "" {
		t.Fatalf("hostname/username should be hidden when title alias is set, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_noteFillsAliasWhenNoDisplayName(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "1", Hostname: "pc-1", Note: "Front desk"}
	alias, note, host, user := rustDeskCardFields(p, "", "", p.Hostname, "alice")
	if alias != "Front desk" {
		t.Fatalf("alias=%q, want Front desk", alias)
	}
	if note != "1" {
		t.Fatalf("note should be peer ID, got %q", note)
	}
	if host != "" || user != "" {
		t.Fatalf("expected cleared secondary hostname line, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_displayNameWinsOverAbAlias(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "99", DisplayName: "Training", Note: "other"}
	alias, note, _, _ := rustDeskCardFields(p, "ClientRename", "", "host", "user")
	if alias != "Training" {
		t.Fatalf("panel display name should win, got %q", alias)
	}
	if note != "other" {
		t.Fatalf("unique panel note should stay secondary, got %q", note)
	}
}

func TestRustDeskCardFields_hostnameBecomesAliasWhenNoLabels(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "42", Hostname: "pc-1"}
	alias, note, host, user := rustDeskCardFields(p, "", "", "pc-1", "alice")
	if alias != "pc-1" {
		t.Fatalf("alias=%q, want hostname as title", alias)
	}
	if note != "42" {
		t.Fatalf("note=%q, want peer ID", note)
	}
	if host != "" || user != "" {
		t.Fatalf("expected cleared hostname chrome, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_abAliasUsedWhenNoPanelLabel(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "7", Hostname: "pc-1"}
	alias, note, host, _ := rustDeskCardFields(p, "My Alias", "", "pc-1", "")
	if alias != "My Alias" {
		t.Fatalf("alias=%q, want My Alias", alias)
	}
	if note != "7" {
		t.Fatalf("note=%q, want peer ID", note)
	}
	if host != "" {
		t.Fatalf("hostname should clear when alias set, got %q", host)
	}
}

func TestRustDeskCardFields_abNotePromotedToAlias(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "1031876693", Hostname: "dcstrainingserver01"}
	alias, note, host, user := rustDeskCardFields(p, "", "Training", p.Hostname, "admin")
	if alias != "Training" {
		t.Fatalf("alias=%q, want Training from AB note", alias)
	}
	if note != "1031876693" {
		t.Fatalf("note=%q, want peer ID", note)
	}
	if host != "" || user != "" {
		t.Fatalf("hostname should hide when AB note becomes title, got host=%q user=%q", host, user)
	}
}

func TestRustDeskPanelAlias(t *testing.T) {
	t.Parallel()
	if got := rustDeskPanelAlias(&db.Peer{DisplayName: " A ", Note: "B"}); got != "A" {
		t.Fatalf("got %q", got)
	}
	if got := rustDeskPanelAlias(&db.Peer{Note: " B "}); got != "B" {
		t.Fatalf("got %q", got)
	}
}
