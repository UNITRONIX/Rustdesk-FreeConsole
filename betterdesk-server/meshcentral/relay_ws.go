package meshcentral

import (
	"context"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/audit"
)

type relayPeer struct {
	ws            *websocket.Conn
	authenticated bool
	userID        string
	browser       bool
}

type relaySession struct {
	id     string
	peer1  *relayPeer
	state  int // 0 waiting, 1 paired, 2 piping
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (g *Gateway) handleRelayWS(w http.ResponseWriter, r *http.Request) {
	if !g.allowIP(w, r) {
		return
	}
	q := r.URL.Query()
	relayID := q.Get("id")
	if relayID == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	var cookieData *RelayCookieData
	if auth := q.Get("auth"); auth != "" {
		cd, err := g.cookies.Decode(auth, 240)
		if err != nil {
			http.Error(w, "invalid auth", http.StatusForbidden)
			return
		}
		cookieData = cd
	}
	if rauth := q.Get("rauth"); rauth != "" {
		cd, err := g.cookies.Decode(rauth, 240)
		if err != nil {
			http.Error(w, "invalid rauth", http.StatusForbidden)
			return
		}
		cookieData = cd
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(32 * 1024 * 1024)

	isBrowser := q.Get("browser") == "1"
	peer := &relayPeer{
		ws:            conn,
		authenticated: cookieData != nil,
		browser:       isBrowser,
	}
	if cookieData != nil && cookieData.RUserID != "" {
		peer.userID = cookieData.RUserID
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if g.ctx != nil {
		ctx2, c2 := context.WithCancel(g.ctx)
		defer c2()
		go func() {
			select {
			case <-g.ctx.Done():
				cancel()
			case <-ctx.Done():
				c2()
			}
		}()
		ctx = ctx2
	}

	g.pairRelay(ctx, relayID, peer, q.Get("p"))
}

func isKvmRelayProto(proto string) bool {
	return proto == "2"
}

func (g *Gateway) pairRelay(ctx context.Context, relayID string, peer *relayPeer, proto string) {
	if isKvmRelayProto(proto) {
		g.runKvmRelayHub(ctx, relayID, peer, proto)
		return
	}
	var session *relaySession
	if v, loaded := g.relays.LoadOrStore(relayID, &relaySession{id: relayID}); loaded {
		session = v.(*relaySession)
	} else {
		session = v.(*relaySession)
		go func() {
			t := time.NewTimer(2 * time.Minute)
			defer t.Stop()
			select {
			case <-t.C:
				g.relays.Delete(relayID)
				g.relayMeta.Delete(relayID)
			case <-ctx.Done():
			}
		}()
	}

	session.mu.Lock()
	if session.peer1 == nil {
		session.peer1 = peer
		session.mu.Unlock()
		<-ctx.Done()
		peer.ws.Close(websocket.StatusNormalClosure, "")
		return
	}
	peer2 := peer
	peer1 := session.peer1
	session.state = 1
	session.mu.Unlock()

	meta := g.getRelayMeta(relayID)
	recording := meta != nil && meta.Record
	sig := RelayConnectSignal(recording)
	peer1.ws.Write(ctx, websocket.MessageText, []byte(sig))
	peer2.ws.Write(ctx, websocket.MessageText, []byte(sig))

	auditUser := peer1.userID
	auditPeer := relayID
	sessionType := proto
	recPath := ""
	if meta != nil {
		if meta.UserID != "" {
			auditUser = meta.UserID
		}
		if meta.PeerID != "" {
			auditPeer = meta.PeerID
		}
		if meta.SessionType != "" {
			sessionType = meta.SessionType
		}
	}

	var recorder *relayRecorder
	if recording && meta != nil && g.cfg != nil {
		dataDir := filepath.Dir(g.cfg.DBPath)
		if dataDir == "" || dataDir == "." {
			dataDir = "."
		}
		if r, path, err := openRelayRecorder(dataDir, meta.PeerID, relayID, meta.SessionType); err == nil {
			recorder = r
			recPath = path
		}
	}

	if g.auditLog != nil {
		g.auditLog.Log(audit.ActionPeerUpdated, auditUser, auditPeer, map[string]string{
			"event": "mesh_relay_paired",
			"proto": proto,
		})
	}

	pipeRelay(ctx, peer1.ws, peer2.ws, recorder)
	if recorder != nil {
		recorder.Close()
	}
	g.relays.Delete(relayID)
	g.relayMeta.Delete(relayID)

	if g.auditLog != nil {
		fields := map[string]string{
			"event": "mesh_session_end",
			"type":  sessionType,
			"proto": proto,
		}
		if recPath != "" {
			fields["recording"] = recPath
		}
		g.auditLog.Log(audit.ActionPeerUpdated, auditUser, auditPeer, fields)
	}
	log.Printf("[mesh] Relay session %s ended", relayID)
}

func pipeRelay(ctx context.Context, a, b *websocket.Conn, recorder *relayRecorder) {
	var wg sync.WaitGroup
	copyWS := func(dst, src *websocket.Conn) {
		defer wg.Done()
		for {
			typ, data, err := src.Read(ctx)
			if err != nil {
				return
			}
			if recorder != nil && len(data) > 0 {
				recorder.Write(int(typ), data)
			}
			if err := dst.Write(ctx, typ, data); err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyWS(b, a)
	go copyWS(a, b)
	wg.Wait()
	a.Close(websocket.StatusNormalClosure, "")
	b.Close(websocket.StatusNormalClosure, "")
}

// KVMRelay handles opaque MNG_KVM binary relay (protocol p=2).
func KVMRelay(ctx context.Context, a, b io.ReadWriter) {
	go func() { io.Copy(b, a) }()
	io.Copy(a, b)
}
