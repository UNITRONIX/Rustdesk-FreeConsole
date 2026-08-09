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
	if note != "" {
		t.Fatalf("note should be cleared when it duplicates alias, got %q", note)
	}
	if host != "" || user != "" {
		t.Fatalf("hostname/username should be hidden when panel alias is set, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_noteFillsAliasWhenNoDisplayName(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "1", Hostname: "pc-1", Note: "Front desk"}
	alias, note, host, user := rustDeskCardFields(p, "", "", p.Hostname, "alice")
	if alias != "Front desk" {
		t.Fatalf("alias=%q, want Front desk", alias)
	}
	if note != "" {
		t.Fatalf("duplicate note should clear, got %q", note)
	}
	if host != "" || user != "" {
		t.Fatalf("expected cleared secondary line, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_displayNameWinsOverAbAlias(t *testing.T) {
	t.Parallel()

	p := &db.Peer{DisplayName: "Training", Note: "other"}
	alias, note, _, _ := rustDeskCardFields(p, "ClientRename", "", "host", "user")
	if alias != "Training" {
		t.Fatalf("panel display name should win, got %q", alias)
	}
	if note != "other" {
		t.Fatalf("distinct note should remain, got %q", note)
	}
}

func TestRustDeskCardFields_keepsHostnameWithoutPanelLabel(t *testing.T) {
	t.Parallel()

	p := &db.Peer{ID: "1", Hostname: "pc-1"}
	alias, note, host, user := rustDeskCardFields(p, "", "", "pc-1", "alice")
	if alias != "" || note != "" {
		t.Fatalf("expected empty alias/note, got alias=%q note=%q", alias, note)
	}
	if host != "pc-1" || user != "alice" {
		t.Fatalf("expected hostname kept, got host=%q user=%q", host, user)
	}
}

func TestRustDeskCardFields_abAliasKeptWhenNoDisplayName(t *testing.T) {
	t.Parallel()

	p := &db.Peer{Hostname: "pc-1"}
	alias, _, host, _ := rustDeskCardFields(p, "My Alias", "", "pc-1", "")
	if alias != "My Alias" {
		t.Fatalf("alias=%q, want My Alias", alias)
	}
	// No panel label → do not strip hostname just because AB alias exists.
	if host != "pc-1" {
		t.Fatalf("host=%q, want pc-1", host)
	}
}

func TestRustDeskCardFields_abNotePromotedWhenAliasEmpty(t *testing.T) {
	t.Parallel()

	// Matches Ole's screenshot: ID bold + hostname + note "Training", empty alias.
	p := &db.Peer{ID: "1031876693", Hostname: "dcstrainingserver01"}
	alias, note, host, user := rustDeskCardFields(p, "", "Training", p.Hostname, "admin")
	if alias != "Training" {
		t.Fatalf("alias=%q, want Training from AB note", alias)
	}
	if note != "" {
		t.Fatalf("duplicate AB note should clear, got %q", note)
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
	if got := rustDeskPanelAlias(nil); got != "" {
		t.Fatalf("got %q", got)
	}
}
