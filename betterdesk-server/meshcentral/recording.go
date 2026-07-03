package meshcentral

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// relayMeta tracks operator session options for a pending relay ID.
type relayMeta struct {
	PeerID      string
	UserID      string
	SessionType string
	Protocol    int
	Record      bool
	ViewOnly    bool
}

func (g *Gateway) setRelayMeta(relayID string, meta *relayMeta) {
	if meta == nil {
		g.relayMeta.Delete(relayID)
		return
	}
	g.relayMeta.Store(relayID, meta)
}

func (g *Gateway) getRelayMeta(relayID string) *relayMeta {
	if v, ok := g.relayMeta.Load(relayID); ok {
		if m, ok := v.(*relayMeta); ok {
			return m
		}
	}
	return nil
}

type relayRecorder struct {
	file *os.File
	mu   sync.Mutex
}

func openRelayRecorder(dataDir, peerID, relayID, sessionType string) (*relayRecorder, string, error) {
	dir := filepath.Join(dataDir, "mesh-recordings")
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, "", err
	}
	name := fmtFilename(peerID, relayID, sessionType)
	path := filepath.Join(dir, name)
	if !pathWithinDir(dir, path) {
		return nil, "", fmt.Errorf("invalid recording path")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0640)
	if err != nil {
		return nil, "", err
	}
	return &relayRecorder{file: f}, path, nil
}

func fmtFilename(peerID, relayID, sessionType string) string {
	ts := time.Now().Format("20060102-150405")
	prefix := relayID
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	return sanitizePathSegment(peerID) + "_" + sanitizePathSegment(sessionType) + "_" + ts + "_" + sanitizePathSegment(prefix) + ".mcrec"
}

func sanitizePathSegment(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
			out = append(out, c)
		} else {
			out = append(out, '_')
		}
	}
	if len(out) == 0 {
		return "segment"
	}
	return string(out)
}

func pathWithinDir(dir, target string) bool {
	cleanDir := filepath.Clean(dir)
	cleanTarget := filepath.Clean(target)
	if cleanDir == cleanTarget {
		return true
	}
	sep := string(os.PathSeparator)
	return strings.HasPrefix(cleanTarget, cleanDir+sep)
}

func (r *relayRecorder) Write(messageType int, data []byte) {
	if r == nil || r.file == nil || len(data) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Simple container: ASCII line prefix + payload (BetterDesk raw capture, not MC-native mcrec).
	header := []byte{byte('T'), byte(messageType), byte(len(data) >> 16), byte(len(data) >> 8), byte(len(data))}
	r.file.Write(header)
	r.file.Write(data)
}

func (r *relayRecorder) Close() {
	if r == nil || r.file == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.file.Close()
	r.file = nil
}
