package meshcentral

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/audit"
)

// relayHub multiplexes one mesh agent tunnel to multiple browser viewers (KVM p=2).
type relayHub struct {
	gateway   *Gateway
	relayID   string
	proto     string
	mu        sync.Mutex
	agent     *relayPeer
	viewers   []*relayPeer
	recorder  *relayRecorder
	recPath   string
	auditUser string
	auditPeer string
	sessionType string
	started   bool
	done      atomic.Bool
}

func (g *Gateway) runKvmRelayHub(ctx context.Context, relayID string, peer *relayPeer, proto string) {
	hub := &relayHub{
		gateway: g,
		relayID: relayID,
		proto:   proto,
	}
	if v, loaded := g.relayHubs.LoadOrStore(relayID, hub); loaded {
		hub = v.(*relayHub)
	} else {
		go hub.idleCleanup(ctx)
	}

	hub.attach(ctx, peer)
	<-ctx.Done()
	hub.detach(peer)
}

func (h *relayHub) idleCleanup(ctx context.Context) {
	t := time.NewTimer(2 * time.Minute)
	defer t.Stop()
	select {
	case <-t.C:
		h.gateway.relayHubs.Delete(h.relayID)
		h.gateway.relayMeta.Delete(h.relayID)
	case <-ctx.Done():
	}
}

func (h *relayHub) attach(ctx context.Context, peer *relayPeer) {
	h.mu.Lock()
	if peer.browser {
		h.viewers = append(h.viewers, peer)
		sig := RelayConnectSignal(h.recorder != nil)
		peer.ws.Write(ctx, websocket.MessageText, []byte(sig))
		if !h.started && h.agent != nil {
			h.startPiping(ctx)
		}
		h.mu.Unlock()
		go h.readViewer(ctx, peer)
		return
	}
	h.agent = peer
	if !h.started && len(h.viewers) > 0 {
		h.startPiping(ctx)
	}
	h.mu.Unlock()
}

func (h *relayHub) detach(peer *relayPeer) {
	h.mu.Lock()
	if peer.browser {
		for i, v := range h.viewers {
			if v == peer {
				h.viewers = append(h.viewers[:i], h.viewers[i+1:]...)
				break
			}
		}
	} else if h.agent == peer {
		h.agent = nil
	}
	empty := h.agent == nil && len(h.viewers) == 0
	h.mu.Unlock()
	if empty {
		h.finish()
	}
}

func (h *relayHub) startPiping(ctx context.Context) {
	if h.started {
		return
	}
	h.started = true

	meta := h.gateway.getRelayMeta(h.relayID)
	recording := meta != nil && meta.Record
	h.auditUser = h.relayID
	h.auditPeer = h.relayID
	h.sessionType = h.proto
	if meta != nil {
		if meta.UserID != "" {
			h.auditUser = meta.UserID
		}
		if meta.PeerID != "" {
			h.auditPeer = meta.PeerID
		}
		if meta.SessionType != "" {
			h.sessionType = meta.SessionType
		}
		if recording && h.gateway.cfg != nil {
			dataDir := filepath.Dir(h.gateway.cfg.DBPath)
			if dataDir == "" || dataDir == "." {
				dataDir = "."
			}
			if r, path, err := openRelayRecorder(dataDir, meta.PeerID, h.relayID, meta.SessionType); err == nil {
				h.recorder = r
				h.recPath = path
			}
		}
	}

	sig := RelayConnectSignal(recording)
	if h.agent != nil {
		h.agent.ws.Write(ctx, websocket.MessageText, []byte(sig))
	}
	for _, v := range h.viewers {
		v.ws.Write(ctx, websocket.MessageText, []byte(sig))
	}

	if h.gateway.auditLog != nil {
		h.gateway.auditLog.Log(audit.ActionPeerUpdated, h.auditUser, h.auditPeer, map[string]string{
			"event": "mesh_relay_paired",
			"proto": h.proto,
			"mode":  "multiplex",
		})
	}

	if h.agent != nil {
		go h.readAgent(ctx)
	}
}

func (h *relayHub) readAgent(ctx context.Context) {
	defer func() {
		h.mu.Lock()
		h.agent = nil
		h.mu.Unlock()
		h.finish()
	}()
	agent := h.agent
	if agent == nil {
		return
	}
	for {
		typ, data, err := agent.ws.Read(ctx)
		if err != nil {
			return
		}
		if h.recorder != nil && len(data) > 0 {
			h.recorder.Write(int(typ), data)
		}
		h.mu.Lock()
		viewers := append([]*relayPeer{}, h.viewers...)
		h.mu.Unlock()
		for _, v := range viewers {
			if err := v.ws.Write(ctx, typ, data); err != nil {
				v.ws.Close(websocket.StatusGoingAway, "")
			}
		}
	}
}

func (h *relayHub) readViewer(ctx context.Context, viewer *relayPeer) {
	for {
		typ, data, err := viewer.ws.Read(ctx)
		if err != nil {
			return
		}
		h.mu.Lock()
		agent := h.agent
		h.mu.Unlock()
		if agent == nil {
			continue
		}
		if h.recorder != nil && len(data) > 0 {
			h.recorder.Write(int(typ), data)
		}
		if err := agent.ws.Write(ctx, typ, data); err != nil {
			return
		}
	}
}

func (h *relayHub) finish() {
	if h.done.Swap(true) {
		return
	}
	if h.recorder != nil {
		h.recorder.Close()
	}
	h.gateway.relayHubs.Delete(h.relayID)
	h.gateway.relayMeta.Delete(h.relayID)
	if h.gateway.auditLog != nil {
		fields := map[string]string{
			"event": "mesh_session_end",
			"type":  h.sessionType,
			"proto": h.proto,
		}
		if h.recPath != "" {
			fields["recording"] = h.recPath
		}
		h.gateway.auditLog.Log(audit.ActionPeerUpdated, h.auditUser, h.auditPeer, fields)
	}
	log.Printf("[mesh] Relay hub %s ended", h.relayID)
}
