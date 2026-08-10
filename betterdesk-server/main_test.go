package main

import (
	"path/filepath"
	"testing"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
)

func TestResolveEnrollmentModeExplicitEnvironmentWins(t *testing.T) {
	mode, source := resolveEnrollmentMode(config.EnrollmentModeOpen, config.EnrollmentModeLocked, true)
	if mode != config.EnrollmentModeOpen || source != "environment" {
		t.Fatalf("resolveEnrollmentMode() = (%q, %q), want (%q, environment)", mode, source, config.EnrollmentModeOpen)
	}
}

func TestResolveEnrollmentModeDatabaseWinsWithoutExplicitEnvironment(t *testing.T) {
	mode, source := resolveEnrollmentMode(config.EnrollmentModeManaged, config.EnrollmentModeLocked, false)
	if mode != config.EnrollmentModeLocked || source != "database" {
		t.Fatalf("resolveEnrollmentMode() = (%q, %q), want (%q, database)", mode, source, config.EnrollmentModeLocked)
	}
}

func TestResolveEnrollmentModeIgnoresInvalidDatabaseValue(t *testing.T) {
	mode, source := resolveEnrollmentMode(config.EnrollmentModeManaged, "invalid", false)
	if mode != config.EnrollmentModeManaged || source != "configuration" {
		t.Fatalf("resolveEnrollmentMode() = (%q, %q), want (%q, configuration)", mode, source, config.EnrollmentModeManaged)
	}
}

func TestApplyEnrollmentModePersistsExplicitEnvironment(t *testing.T) {
	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "enrollment.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := database.SetConfig("enrollment_mode", config.EnrollmentModeLocked); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = config.EnrollmentModeOpen
	cfg.EnrollmentModeEnvOverride = true

	source, err := applyEnrollmentMode(cfg, database)
	if err != nil {
		t.Fatal(err)
	}
	if source != "environment" || cfg.EnrollmentMode != config.EnrollmentModeOpen {
		t.Fatalf("applyEnrollmentMode() source=%q mode=%q", source, cfg.EnrollmentMode)
	}
	stored, err := database.GetConfig("enrollment_mode")
	if err != nil {
		t.Fatal(err)
	}
	if stored != config.EnrollmentModeOpen {
		t.Fatalf("persisted enrollment mode = %q, want %q", stored, config.EnrollmentModeOpen)
	}
}

func TestApplyEnrollmentModeRestoresDatabaseWithoutOverride(t *testing.T) {
	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "enrollment.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := database.SetConfig("enrollment_mode", config.EnrollmentModeLocked); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = config.EnrollmentModeManaged

	source, err := applyEnrollmentMode(cfg, database)
	if err != nil {
		t.Fatal(err)
	}
	if source != "database" || cfg.EnrollmentMode != config.EnrollmentModeLocked {
		t.Fatalf("applyEnrollmentMode() source=%q mode=%q", source, cfg.EnrollmentMode)
	}
}
