package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// handleReplaceBinary lets the panel replace betterdesk-server.exe in-place.
//
// Why this exists: NT SERVICE\BetterDeskConsole cannot sc stop / taskkill
// BetterDeskServer. The running server process *can* rename its own image on
// Windows and write a new binary, then exit so NSSM AppExit=Restart loads it.
// Stopping BetterDeskConsole mid-Apply would kill the update itself — so we
// never stop both services from inside the panel process.
//
// POST /api/system/replace-binary
// Body: { "source": "<absolute path to new betterdesk-server binary>" }
func (s *Server) handleReplaceBinary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}

	var req struct {
		Source string `json:"source"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	source := strings.TrimSpace(req.Source)
	if source == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source required"})
		return
	}

	absSource, err := filepath.Abs(source)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source path"})
		return
	}
	if err := validateReplaceBinarySource(absSource); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	exe, err := os.Executable()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot resolve running executable"})
		return
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		// Non-fatal on Windows when no symlink
		exe, _ = filepath.Abs(exe)
	}

	backup, err := replaceRunningExecutable(absSource, exe)
	if err != nil {
		log.Printf("[api] replace-binary failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[api] replace-binary ok source=%s target=%s backup=%s — exiting for NSSM restart", absSource, exe, backup)
	writeJSON(w, http.StatusOK, map[string]any{
		"success":    true,
		"target":     exe,
		"backupPath": backup,
		"restarting": true,
	})

	go func() {
		time.Sleep(400 * time.Millisecond)
		os.Exit(0)
	}()
}

func validateReplaceBinarySource(absSource string) error {
	base := strings.ToLower(filepath.Base(absSource))
	if runtime.GOOS == "windows" {
		if base != "betterdesk-server.exe" && !strings.HasSuffix(base, "betterdesk-server.exe") {
			// Allow stamped names like betterdesk-server.exe.new.123
			if !strings.Contains(base, "betterdesk-server") || !strings.HasSuffix(base, ".exe") {
				return fmt.Errorf("source must be a betterdesk-server Windows binary")
			}
		}
	} else if base != "betterdesk-server" && !strings.Contains(base, "betterdesk-server") {
		return fmt.Errorf("source must be a betterdesk-server binary")
	}

	st, err := os.Stat(absSource)
	if err != nil {
		return fmt.Errorf("source not readable: %w", err)
	}
	if st.IsDir() {
		return fmt.Errorf("source is a directory")
	}
	if st.Size() < 1<<20 {
		return fmt.Errorf("source too small (%d bytes)", st.Size())
	}
	if st.Size() > 250<<20 {
		return fmt.Errorf("source too large (%d bytes)", st.Size())
	}

	if runtime.GOOS == "windows" {
		f, err := os.Open(absSource)
		if err != nil {
			return err
		}
		defer f.Close()
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(f, hdr); err != nil {
			return fmt.Errorf("cannot read PE header: %w", err)
		}
		if hdr[0] != 'M' || hdr[1] != 'Z' {
			return fmt.Errorf("source is not a Windows PE executable")
		}
	}
	return nil
}

func replaceRunningExecutable(source, target string) (backupPath string, err error) {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	if st, err := os.Stat(target); err == nil && !st.IsDir() {
		backupPath = fmt.Sprintf("%s.bak.%d", target, time.Now().UnixMilli())
		if err := copyFileContents(target, backupPath); err != nil {
			return "", fmt.Errorf("backup failed: %w", err)
		}
		aside := fmt.Sprintf("%s.old.%d", target, time.Now().UnixMilli())
		if err := os.Rename(target, aside); err != nil {
			// Some volumes refuse rename of a mapped image — try overwrite via staging.
			log.Printf("[api] replace-binary rename aside failed (%v) — trying direct overwrite", err)
		}
	}

	staging := fmt.Sprintf("%s.new.%d.%d", target, os.Getpid(), time.Now().UnixMilli())
	if err := copyFileContents(source, staging); err != nil {
		return backupPath, fmt.Errorf("stage copy failed: %w", err)
	}
	if err := os.Rename(staging, target); err != nil {
		if copyErr := copyFileContents(staging, target); copyErr != nil {
			_ = os.Remove(staging)
			return backupPath, fmt.Errorf("install failed: %v / %v", err, copyErr)
		}
		_ = os.Remove(staging)
	}
	return backupPath, nil
}

func copyFileContents(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
