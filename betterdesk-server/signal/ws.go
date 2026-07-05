package signal

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
)

var wsSignalKeepAliveInterval = time.Duration(config.HeartbeatSuggestion) * time.Second / 2

// serveWS starts the WebSocket signal listener (e.g., port 21118).
// RustDesk web clients connect here for the same signal protocol,
// using raw protobuf in binary WS frames (no 2-byte TCP header).
// Phase 3: Supports WSS when TLS is enabled for signal server.
func (s *Server) serveWS() {
	defer s.wg.Done()

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleWSUpgrade)

	addr := fmt.Sprintf(":%d", s.cfg.WSSignalPort())
	s.wsHTTP = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: config.WSConnTimeout,
		BaseContext: func(l net.Listener) context.Context {
			return s.ctx
		},
	}

	if s.cfg.SignalTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			log.Printf("[signal] WSS TLS config error: %v", err)
			return
		}
		s.wsHTTP.TLSConfig = tlsCfg
		log.Printf("[signal] WSS listening on %s (TLS enabled)", addr)
		if err := s.wsHTTP.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Printf("[signal] WSS server error: %v", err)
		}
	} else {
		if len(s.cfg.GetAllowedWSOrigins()) == 0 {
			log.Printf("[signal] WS origin allowlist not configured — only localhost browser origins are accepted by default")
		}
		log.Printf("[signal] WS listening on %s", addr)
		if err := s.wsHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[signal] WS server error: %v", err)
		}
	}
}

// handleWSUpgrade upgrades an HTTP request to a WebSocket connection
// and enters the signal message loop.
func (s *Server) handleWSUpgrade(w http.ResponseWriter, r *http.Request) {
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
		log.Printf("[signal] WS upgrade error: %v", err)
		return
	}
	remoteAddr := wsEffectiveRemoteAddr(r)

	log.Printf("[signal] WS upgrade remote=%s effective=%s path=%s origin=%q ua=%q xff=%q xri=%q",
		r.RemoteAddr, remoteAddr, r.URL.Path,
		r.Header.Get("Origin"), r.Header.Get("User-Agent"),
		r.Header.Get("X-Forwarded-For"), r.Header.Get("X-Real-IP"))

	// Increase read limit for file transfer signaling
	ws.SetReadLimit(256 * 1024)

	wsc := codec.NewWSConn(ws, s.ctx, remoteAddr)

	// Persistent connection — read messages in a loop until close or error.
	s.wsSignalLoop(wsc)
}

// wsEffectiveRemoteAddr returns the client address for WS signal registration.
// When behind a reverse proxy, prefer X-Real-IP then the first X-Forwarded-For
// hop (same behaviour as rustdesk-server WS upgrade).
func wsEffectiveRemoteAddr(r *http.Request) string {
	clientIP := strings.TrimSpace(r.Header.Get("X-Real-IP"))
	if clientIP == "" {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			clientIP = strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
		}
	}
	if clientIP != "" {
		if strings.Contains(clientIP, ":") {
			return fmt.Sprintf("[%s]:0", clientIP)
		}
		return fmt.Sprintf("%s:0", clientIP)
	}
	return r.RemoteAddr
}

func bindPeerWSConn(s *Server, peerID string, wsc *codec.WSConn) {
	if peerID == "" {
		return
	}
	entry := s.peers.Get(peerID)
	if entry != nil {
		entry.ConnType = peer.ConnWS
		entry.WSConn = wsc
	}
}

func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// wsSignalLoop reads protobuf messages from a WS connection and dispatches them.
// Unlike TCP (single request-response), WS connections stay open for streaming
// heartbeats and bi-directional signaling.
func (s *Server) wsSignalLoop(wsc *codec.WSConn) {
	defer wsc.Close()

	remoteAddr := wsc.RemoteAddr()
	peerID := ""
	wsc.SetKeepAliveHandler(func() {
		if peerID != "" {
			s.peers.TouchHeartbeat(peerID)
		}
	})
	keepAliveDone := make(chan struct{})
	go s.wsSignalKeepAlive(wsc, keepAliveDone)
	defer close(keepAliveDone)

	for {
		msg, err := wsc.ReadMessage()
		if err != nil {
			// Normal close or context cancelled — not an error
			select {
			case <-s.ctx.Done():
			default:
				if websocket.CloseStatus(err) == -1 {
					since, readFrames, writeFrames, readAny, writeAny := wsc.SessionSummary()
					log.Printf("[signal] WS read from %s: %v (uptime=%s read_frames=%d write_frames=%d read_any=%v write_any=%v peer=%q)",
						remoteAddr, err, since.Round(time.Millisecond), readFrames, writeFrames, readAny, writeAny, peerID)
				}
			}
			return
		}

		switch {
		case msg.GetRegisterPeer() != nil:
			peerID = msg.GetRegisterPeer().Id
			resp := s.handleRegisterPeerWS(msg.GetRegisterPeer(), remoteAddr)
			if resp != nil {
				bindPeerWSConn(s, peerID, wsc)
				wsc.WriteMessage(resp)
			}

		case msg.GetRegisterPk() != nil:
			peerID = msg.GetRegisterPk().Id
			resp := s.processRegisterPk(msg.GetRegisterPk(), remoteAddr)
			if resp != nil {
				if rpk := resp.GetRegisterPkResponse(); rpk != nil && rpk.GetResult() == pb.RegisterPkResponse_OK {
					bindPeerWSConn(s, peerID, wsc)
				}
				wsc.WriteMessage(resp)
			}

		case msg.GetPunchHoleRequest() != nil:
			fakeAddr, _ := net.ResolveUDPAddr("udp", remoteAddr)
			resp := s.handlePunchHoleRequestTCP(msg.GetPunchHoleRequest(), fakeAddr)
			if resp != nil {
				wsc.WriteMessage(resp)
			}

		case msg.GetTestNatRequest() != nil:
			// NAT test over WS — extract port from remote address (limited value)
			fakeAddr, _ := net.ResolveTCPAddr("tcp", remoteAddr)
			resp := s.handleTestNat(msg.GetTestNatRequest(), fakeAddr)
			if resp != nil {
				wsc.WriteMessage(resp)
			}

		case msg.GetOnlineRequest() != nil:
			resp := s.handleOnlineRequest(msg.GetOnlineRequest())
			if resp != nil {
				wsc.WriteMessage(resp)
			}

		case msg.GetRequestRelay() != nil:
			// Use the TCP handler which returns an immediate RelayResponse with
			// signed PK — the UDP handler would send the response via UDP which
			// the WebSocket client cannot receive.
			fakeAddr, _ := net.ResolveUDPAddr("udp", remoteAddr)
			if fakeAddr != nil {
				resp := s.handleRequestRelayTCP(msg.GetRequestRelay(), fakeAddr)
				if resp != nil {
					wsc.WriteMessage(resp)
				}
			}

		case msg.GetFetchLocalAddr() != nil:
			fakeAddr, _ := net.ResolveUDPAddr("udp", remoteAddr)
			if fakeAddr != nil {
				s.handleFetchLocalAddr(msg.GetFetchLocalAddr(), fakeAddr)
			}

		case msg.GetLocalAddr() != nil:
			fakeAddr, _ := net.ResolveUDPAddr("udp", remoteAddr)
			if fakeAddr != nil {
				s.handleLocalAddr(msg.GetLocalAddr(), fakeAddr)
			}

		case msg.GetHc() != nil:
			resp := &pb.RendezvousMessage{
				Union: &pb.RendezvousMessage_Hc{
					Hc: &pb.HealthCheck{Token: msg.GetHc().Token},
				},
			}
			wsc.WriteMessage(resp)

		default:
			log.Printf("[signal] WS: unhandled message from %s", remoteAddr)
		}
	}
}

func (s *Server) wsSignalKeepAlive(wsc *codec.WSConn, done <-chan struct{}) {
	if wsSignalKeepAliveInterval <= 0 {
		return
	}

	// Send an immediate empty frame so proxies and RustDesk desktop clients see
	// activity right after the HTTP 101 (desktop may wait ~1s before RegisterPk).
	if err := wsc.WriteKeepAlive(); err != nil {
		if !isNormalClose(err) {
			log.Printf("[signal] WS initial keepalive write to %s: %v", wsc.RemoteAddr(), err)
		}
		return
	}

	ticker := time.NewTicker(wsSignalKeepAliveInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			if err := wsc.WriteKeepAlive(); err != nil {
				if !isNormalClose(err) {
					log.Printf("[signal] WS keepalive write to %s: %v", wsc.RemoteAddr(), err)
				}
				return
			}
		}
	}
}

// handleRegisterPeerWS processes a heartbeat over WebSocket.
// Similar to handleRegisterPeer but uses the WS remote address.
func (s *Server) handleRegisterPeerWS(msg *pb.RegisterPeer, remoteAddr string) *pb.RendezvousMessage {
	id := msg.Id
	if id == "" {
		return nil
	}
	clientHost := hostFromAddrString(remoteAddr)

	if !isValidPeerID(id) {
		log.Printf("[signal] Rejected invalid WS peer ID format: %q from %s", id, clientHost)
		return nil
	}

	if s.blocklist != nil {
		if s.blocklist.IsIPBlocked(clientHost) {
			log.Printf("[signal] Blocked IP %s tried WS registration", clientHost)
			return nil
		}
		if s.blocklist.IsIDBlocked(id) {
			log.Printf("[signal] Blocked ID %s tried WS registration", id)
			return nil
		}
	}

	if effectiveID, ok := s.resolveRegistrationPeerID(id, clientHost, nil, nil); !ok {
		return nil
	} else if effectiveID != id {
		id = effectiveID
	}

	existing := s.peers.Get(id)
	knownPeer := existing != nil
	if !knownPeer {
		if dbPeer, err := s.db.GetPeer(id); err == nil && dbPeer != nil {
			knownPeer = true
		}
	}
	if !s.allowRegistration(clientHost, id, knownPeer) {
		if knownPeer {
			log.Printf("[signal] Rate limited WS registration from %s for peer %s", clientHost, id)
		} else {
			log.Printf("[signal] Rate limited new WS registration from %s for peer %s", clientHost, id)
		}
		return nil
	}
	if existing != nil {
		// Reject banned peers — do not heartbeat or respond
		if existing.Banned {
			log.Printf("[signal] Rejected banned WS peer heartbeat: %s from %s", id, remoteAddr)
			return nil
		}
		if s.rejectIfPeerSoftDeleted(id, clientHost) {
			return nil
		}
		if banned, _ := s.db.IsPeerBanned(id); banned {
			log.Printf("[signal] Rejected banned WS peer heartbeat: %s from %s", id, remoteAddr)
			return nil
		}

		// Update heartbeat (WS has no real UDP addr)
		existing.LastReg = time.Now()
		existing.Serial = msg.Serial
		existing.ConnType = peer.ConnWS
		existing.IP = remoteAddr

		requestPk := len(existing.PK) == 0
		s.db.UpdatePeerStatus(id, "ONLINE", remoteAddr)

		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPeerResponse{
				RegisterPeerResponse: &pb.RegisterPeerResponse{
					RequestPk: requestPk,
				},
			},
		}
	}

	if s.rejectIfPeerSoftDeleted(id, clientHost) {
		return nil
	}

	if !s.checkEnrollmentPermission(id, clientHost) {
		log.Printf("[signal] Rejected new WS peer %s from %s (enrollment policy)", id, clientHost)
		return nil
	}

	// Check if this peer is banned in the database (e.g. removed from memory
	// map after ban but trying to re-register via WS)
	if banned, _ := s.db.IsPeerBanned(id); banned {
		log.Printf("[signal] Rejected banned WS peer registration: %s from %s", id, remoteAddr)
		return nil
	}

	// New peer via WS
	entry := &peer.Entry{
		ID:       id,
		IP:       remoteAddr,
		Serial:   msg.Serial,
		ConnType: peer.ConnWS,
		LastReg:  time.Now(),
	}
	s.peers.Put(entry)

	log.Printf("[signal] New WS peer registered: %s from %s", id, remoteAddr)
	s.db.UpdatePeerStatus(id, "ONLINE", remoteAddr)
	s.publishPeerOnline(id)

	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeerResponse{
			RegisterPeerResponse: &pb.RegisterPeerResponse{
				RequestPk: true,
			},
		},
	}
}

// sendToWSPeer sends a protobuf message to a peer connected via WebSocket.
func (s *Server) sendToWSPeer(id string, msg *pb.RendezvousMessage) error {
	entry := s.peers.Get(id)
	if entry == nil || entry.ConnType != peer.ConnWS || entry.WSConn == nil {
		return fmt.Errorf("peer %s not connected via WS", id)
	}
	wsc, ok := entry.WSConn.(*codec.WSConn)
	if !ok {
		return fmt.Errorf("peer %s has invalid WS connection", id)
	}
	return wsc.WriteMessage(msg)
}

// sendToPeer sends a protobuf message to a peer using whatever transport it's connected on.
func (s *Server) sendToPeer(id string, msg *pb.RendezvousMessage) {
	entry := s.peers.Get(id)
	if entry == nil {
		return
	}

	switch entry.ConnType {
	case peer.ConnUDP:
		if entry.UDPAddr != nil {
			s.sendUDP(msg, entry.UDPAddr)
		}
	case peer.ConnWS:
		if entry.WSConn != nil {
			wsc, ok := entry.WSConn.(*codec.WSConn)
			if ok {
				if err := wsc.WriteMessage(msg); err != nil {
					log.Printf("[signal] WS send to %s: %v", id, err)
				}
			}
		}
	case peer.ConnTCP:
		if entry.TCPConn != nil {
			if err := codec.WriteRawProto(entry.TCPConn, msg); err != nil {
				log.Printf("[signal] TCP send to %s: %v", id, err)
			}
		}
	}
}
