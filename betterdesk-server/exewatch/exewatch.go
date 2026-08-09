package exewatch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"os"
	"time"
)

// Fingerprint is a cheap identity of the on-disk executable.
type Fingerprint struct {
	Size    int64
	ModUnix int64
	HeadHex string
}

// FileFingerprint samples size, mtime, and the first 64KiB of path.
func FileFingerprint(path string) (Fingerprint, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Fingerprint{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Fingerprint{}, err
	}
	defer f.Close()

	h := sha256.New()
	_, err = io.CopyN(h, f, 64<<10)
	if err != nil && err != io.EOF {
		return Fingerprint{}, err
	}
	return Fingerprint{
		Size:    st.Size(),
		ModUnix: st.ModTime().UnixNano(),
		HeadHex: hex.EncodeToString(h.Sum(nil)[:16]),
	}, nil
}

func (a Fingerprint) Equal(b Fingerprint) bool {
	return a.Size == b.Size && a.ModUnix == b.ModUnix && a.HeadHex == b.HeadHex
}

// WatchExecutable exits the process when the file at os.Executable() changes
// on disk. Used after Windows panel "rename-swap" deploy: the new binary is
// already at the service path while this process still runs the old image;
// exiting lets NSSM AppExit=Restart load the replacement.
func WatchExecutable(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	exe, err := os.Executable()
	if err != nil {
		log.Printf("[exewatch] executable path unavailable: %v", err)
		return
	}
	baseline, err := FileFingerprint(exe)
	if err != nil {
		log.Printf("[exewatch] baseline fingerprint failed: %v", err)
		return
	}
	log.Printf("[exewatch] watching %s for on-disk replacement", exe)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cur, err := FileFingerprint(exe)
			if err != nil {
				continue
			}
			if !cur.Equal(baseline) {
				log.Printf("[exewatch] on-disk executable changed (size %d→%d) — exiting for service restart",
					baseline.Size, cur.Size)
				os.Exit(0)
			}
		}
	}
}
