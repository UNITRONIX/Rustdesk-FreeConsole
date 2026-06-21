package meshcentral

import (
	"os"
	"path/filepath"
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
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0640)
	if err != nil {
		return nil, "", err
	}
	return &relayRecorder{file: f}, path, nil
}

func fmtFilename(peerID, relayID, sessionType string) string {
	ts := time.Now().Format("20060102-150405")
	safe := stringsMapPeer(peerID)
	return safe + "_" + sessionType + "_" + ts + "_" + relayID[:8] + ".mcrec"
}

func stringsMapPeer(id string) string {
	out := make([]byte, 0, len(id))
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
			out = append(out, c)
		} else {
			out = append(out, '_')
		}
	}
	if len(out) == 0 {
		return "peer"
	}
	return string(out)
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
