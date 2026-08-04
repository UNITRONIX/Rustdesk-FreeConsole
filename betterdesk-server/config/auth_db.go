package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ResolveAuthDBPath finds legacy console auth.db (SQLite panel ACL / device groups).
// PostgreSQL deployments use PanelSyncStore on the primary database instead and
// do not need this path when DB_URL is postgres://…
//
// Prefer an explicit path (AUTH_DB_PATH via LoadEnv) or BETTERDESK_AUTH_DB_PATH.
// Otherwise probe env-based dirs, then common install layouts, then paths relative
// to the Go peer DB / server executable.
func ResolveAuthDBPath(explicit, dbPath string) string {
	if strings.TrimSpace(explicit) != "" {
		return explicit
	}
	if v := strings.TrimSpace(os.Getenv("BETTERDESK_AUTH_DB_PATH")); v != "" {
		return v
	}

	var candidates []string
	if v := os.Getenv("CONSOLE_PATH"); v != "" {
		candidates = append(candidates, filepath.Join(v, "data", "auth.db"))
	}
	if v := os.Getenv("CONSOLE_DATA_DIR"); v != "" {
		candidates = append(candidates, filepath.Join(v, "auth.db"))
	}
	if v := os.Getenv("DATA_DIR"); v != "" {
		candidates = append(candidates, filepath.Join(v, "auth.db"))
	}

	candidates = append(candidates,
		"/opt/BetterDeskConsole/data/auth.db",
		"/opt/rustdesk/../BetterDeskConsole/data/auth.db",
	)
	if runtime.GOOS == "windows" {
		candidates = append(candidates,
			`C:\BetterDeskConsole\data\auth.db`,
			`C:\Program Files\BetterDeskConsole\data\auth.db`,
		)
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			candidates = append(candidates, filepath.Join(local, "BetterDeskConsole", "data", "auth.db"))
		}
	}

	if dbPath != "" && !strings.HasPrefix(dbPath, "postgres") {
		dir := filepath.Dir(dbPath)
		candidates = append(candidates,
			filepath.Join(dir, "auth.db"),
			filepath.Join(dir, "../data", "auth.db"),
			filepath.Join(dir, "../../BetterDeskConsole/data", "auth.db"),
			filepath.Join(dir, "../BetterDeskConsole/data", "auth.db"),
		)
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "BetterDeskConsole", "data", "auth.db"),
			filepath.Join(dir, "data", "auth.db"),
		)
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return explicit
}
