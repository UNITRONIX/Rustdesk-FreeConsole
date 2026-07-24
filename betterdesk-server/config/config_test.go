package config

import (
	"os"
	"testing"
)

func TestLoadEnv_GOAPIPortPrecedenceOverAPIPort(t *testing.T) {
	t.Setenv("GO_API_PORT", "21114")
	t.Setenv("API_PORT", "21121")

	cfg := DefaultConfig()
	cfg.APIPort = 9999
	cfg.LoadEnv()

	if cfg.APIPort != 21114 {
		t.Fatalf("APIPort = %d, want 21114 (GO_API_PORT should win over API_PORT)", cfg.APIPort)
	}
}

func TestLoadEnv_APIPortLegacyFallback(t *testing.T) {
	t.Setenv("GO_API_PORT", "")
	os.Unsetenv("GO_API_PORT")
	t.Setenv("API_PORT", "21121")

	cfg := DefaultConfig()
	cfg.APIPort = 9999
	cfg.LoadEnv()

	if cfg.APIPort != 21121 {
		t.Fatalf("APIPort = %d, want 21121 (legacy API_PORT-only installs)", cfg.APIPort)
	}
}

func TestLoadEnv_SignalPortPrecedenceOverPort(t *testing.T) {
	t.Setenv("SIGNAL_PORT", "21116")
	t.Setenv("PORT", "5000")

	cfg := DefaultConfig()
	cfg.SignalPort = 9999
	cfg.LoadEnv()

	if cfg.SignalPort != 21116 {
		t.Fatalf("SignalPort = %d, want 21116 (SIGNAL_PORT should win over PORT)", cfg.SignalPort)
	}
}
