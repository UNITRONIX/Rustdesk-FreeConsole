package db

import (
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

// sqliteFileURI builds a SQLite URI filename for the given filesystem path.
// Windows paths must use forward slashes; raw backslashes in file: URIs are
// misparsed and yield SQLITE_CANTOPEN (14) even when the file exists.
func sqliteFileURI(path string, query url.Values) string {
	abs := strings.TrimSpace(path)
	if abs == "" {
		return "file::memory:?mode=memory"
	}
	// Preserve classic in-memory URI (filepath.Abs would turn ":memory:" into a bogus path).
	if abs == ":memory:" {
		u := "file::memory:"
		if len(query) > 0 {
			u += "?" + query.Encode()
		}
		return u
	}
	if a, err := filepath.Abs(abs); err == nil {
		abs = a
	}
	p := filepath.ToSlash(abs)
	// Absolute Windows path → /C:/dir/file.db so SQLite treats it as a volume path.
	if runtime.GOOS == "windows" && len(p) >= 2 && p[1] == ':' {
		p = "/" + p
	}
	u := "file:" + p
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}
