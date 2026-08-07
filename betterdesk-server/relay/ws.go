package relay

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	pb "github.com/unitronix/betterdesk-server/proto"
)

// MaxWSRelayMessage is the max WebSocket binary message size for relay data.
// Matches RustDesk / support-agent MaxPeerFrameSize (16 MiB).
const MaxWSRelayMessage = 16 * 1024 * 1024

// serveWS starts the WebSocket relay listener (e.g., port 21119).
// RustDesk WebSocket Mode clients use this for relay traffic over WSS.
// Phase 3: Supports WSS when TLS is enabled for relay server.
func (s *Server) serveWS() {
	defer s.wg.Done()

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleWSRelayUpgrade)

	addr := fmt.Sprintf(":%d", s.cfg.WSRelayPort())
	s.wsHTTP = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: config.WSConnTimeout,
		WriteTimeout:      0, // No write timeout for relay pipe
		BaseContext: func(l net.Listener) context.Context {
			return s.ctx
		},
	}

	// Phase 3: Enable WSS if TLS is configured for relay server.
	if s.cfg.RelayTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			log.Printf("[relay] WSS TLS config error: %v", err)
			return
		}
		s.wsHTTP.TLSConfig = tlsCfg
		log.Printf("[relay] WSS listening on %s (TLS enabled)", addr)
		if err := s.wsHTTP.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Printf("[relay] WSS server error: %v", err)
		}
	} else {
		if len(s.cfg.GetAllowedWSOrigins()) == 0 {
			log.Printf("[relay] WS origin allowlist not configured — only localhost browser origins are accepted by default")
		}
		log.Printf("[relay] WS listening on %s", addr)
		if err := s.wsHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[relay] WS server error: %v", err)
		}
	}
}

// handleWSRelayUpgrade upgrades to WebSocket and handles relay pairing.
// After upgrade, the first binary frame must be a RequestRelay (with UUID).
// The raw *websocket.Conn is kept for message-boundary-preserving relay (#293).
func (s *Server) handleWSRelayUpgrade(w http.ResponseWriter, r *http.Request) {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	if s.connLimiter != nil && !s.connLimiter.Acquire(ip) {
		log.Printf("[relay] WS connection rejected from %s (per-IP limit exceeded)", ip)
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	if s.connLimiter != nil {
		defer s.connLimiter.Release(ip)
	}

	opts := &websocket.AcceptOptions{}

	// Secure-by-default origin validation:
	// - if WS_ALLOWED_ORIGINS is set, use the explicit allowlist
	// - otherwise, only allow browser origins from localhost/127.0.0.1
	// - non-browser/native clients without Origin are still accepted
	allowed := s.cfg.GetAllowedWSOrigins()
	if len(allowed) > 0 {
		opts.OriginPatterns = allowed
	} else if origin := r.Header.Get("Origin"); origin != "" && !isLoopbackOrigin(origin) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}

	ws, err := websocket.Accept(w, r, opts)
	if err != nil {
		log.Printf("[relay] WS upgrade error: %v", err)
		return
	}

	// Cap message size for video frames (H.265 IDR can exceed the old 8 MiB limit).
	ws.SetReadLimit(MaxWSRelayMessage)

	wsc := codec.NewWSConn(ws, s.ctx, r.RemoteAddr)

	// Read the first message — must be RequestRelay or HealthCheck
	msg, err := wsc.ReadMessage()
	if err != nil {
		log.Printf("[relay] WS ReadMessage failed from %s: %v", r.RemoteAddr, err)
		wsc.Close()
		return
	}

	// Handle health check
	if hc := msg.GetHc(); hc != nil {
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_Hc{
				Hc: &pb.HealthCheck{Token: hc.Token},
			},
		}
		if err := wsc.WriteMessage(resp); err != nil {
			log.Printf("[relay] WS health check response failed to %s: %v", r.RemoteAddr, err)
		}
		wsc.Close()
		return
	}

	rr := msg.GetRequestRelay()
	if rr == nil || rr.Uuid == "" {
		log.Printf("[relay] WS missing or empty UUID from %s (rejecting)", r.RemoteAddr)
		wsc.Close()
		return
	}

	uuid := rr.Uuid
	if !s.claimRelayTicket(uuid) {
		log.Printf("[relay] WS unauthorized relay UUID from %s (rejecting)", r.RemoteAddr)
		wsc.Close()
		return
	}
	log.Printf("[relay] WS connection from %s for UUID %s", r.RemoteAddr, uuid)

	// Keep the raw WebSocket for message-preserving bidirectional copy.
	// Do NOT wrap with websocket.NetConn + io.Copy: NetConn.Write creates a new
	// WS message per Write, and io.Copy's ~32 KiB buffer splits large encrypted
	// video frames — clients then fail with decryption error (#293).
	s.pairIncomingConn(&pendingConn{
		ws:        ws,
		remote:    r.RemoteAddr,
		transport: relayTransportWS,
		created:   timeNow(),
		done:      make(chan struct{}),
	}, uuid)
}

func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// startWSRelay runs a message-boundary-preserving bidirectional pipe between
// two WebSocket relay peers (#293).
func (s *Server) startWSRelay(ws1, ws2 *websocket.Conn, addr1, addr2, uuid string) {
	if s.sessionLimiter != nil {
		ips := make([]string, 0, 2)
		for _, addr := range []string{addr1, addr2} {
			ip, _, err := net.SplitHostPort(addr)
			if err != nil {
				ip = addr
			}
			if !s.sessionLimiter.Acquire(ip) {
				log.Printf("[relay] Active session limit exceeded for %s (UUID %s)", ip, uuid)
				_ = ws1.Close(websocket.StatusNormalClosure, "")
				_ = ws2.Close(websocket.StatusNormalClosure, "")
				return
			}
			ips = append(ips, ip)
		}
		defer func() {
			for _, ip := range ips {
				s.sessionLimiter.Release(ip)
			}
		}()
	}

	s.ActiveSessions.Add(1)
	s.TotalRelayed.Add(1)

	log.Printf("[relay] Pair established: %s <-> %s (UUID: %s, transport=ws)",
		addr1, addr2, uuid)

	if s.onRelayStart != nil {
		s.onRelayStart(uuid)
	}

	// Register bandwidth sessions (same accounting as TCP WrapReader x2).
	var pace1, pace2 io.Writer
	if s.bwLimiter != nil {
		_ = s.bwLimiter.WrapReader(bytes.NewReader(nil))
		_ = s.bwLimiter.WrapReader(bytes.NewReader(nil))
		pace1 = s.bwLimiter.WrapWriter(io.Discard)
		pace2 = s.bwLimiter.WrapWriter(io.Discard)
	}

	idle := config.RelayIdleTimeout
	done := make(chan struct{})
	var once sync.Once

	go func() {
		copyWSMessages(s.ctx, ws1, ws2, pace2, idle)
		once.Do(func() { close(done) })
	}()
	go func() {
		copyWSMessages(s.ctx, ws2, ws1, pace1, idle)
		once.Do(func() { close(done) })
	}()

	<-done

	if s.onRelayEnd != nil {
		s.onRelayEnd(uuid)
	}

	_ = ws1.Close(websocket.StatusNormalClosure, "")
	_ = ws2.Close(websocket.StatusNormalClosure, "")

	if s.bwLimiter != nil {
		s.bwLimiter.SessionDone()
		s.bwLimiter.SessionDone()
	}

	s.ActiveSessions.Add(-1)
	log.Printf("[relay] Session ended: UUID %s (active: %d)", uuid, s.ActiveSessions.Load())
}

// copyWSMessages forwards complete WebSocket messages from src to dst.
// Each Read payload is written as a single Write so large encrypted frames
// (video) are not split across message boundaries.
func copyWSMessages(ctx context.Context, dst, src *websocket.Conn, pace io.Writer, idle time.Duration) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, idle)
		typ, data, err := src.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if pace != nil && len(data) > 0 {
			_, _ = pace.Write(data)
		}
		writeCtx, cancel := context.WithTimeout(ctx, idle)
		err = dst.Write(writeCtx, typ, data)
		cancel()
		if err != nil {
			return
		}
	}
}

// NOTE: confirmRelay was removed — the RustDesk client does not expect
// a RelayResponse from the relay server. Sending one breaks the E2E
// encryption handshake (see startRelay comment in server.go).
