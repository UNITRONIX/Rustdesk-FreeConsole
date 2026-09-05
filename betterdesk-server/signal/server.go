// Package signal implements the BetterDesk signal server (hbbs equivalent).
// It handles device registration, hole punching, NAT tests, and online queries
// over UDP, TCP, and WebSocket transports.
package signal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/billing"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/policy"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/security"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// tcpPunchConn tracks a TCP signal connection that is waiting for forwarded
// messages (e.g., RelayResponse from target). The write mutex serialises all
// writes to the connection so that both the main read-loop and the forwarder
// can safely write.
type tcpPunchConn struct {
	conn      net.Conn              // underlying connection (plain mode)
	secure    *crypto.SecureTCPConn // set when connection uses NaCl encryption
	writeMu   sync.Mutex
	createdAt time.Time // M2: track creation time for TTL eviction
	peerID    string    // set after RegisterPk on this TCP session (#327)
}

// pendingUUID tracks a relay session correlation for RelayResponse forwarding
// (#399). Some RustDesk clients omit the UUID in RelayResponse; others omit
// initiator identity. We store both so the reverse path does not fall back to
// unsafe FindByIP on shared NAT.
type pendingUUID struct {
	uuid        string
	targetID    string
	initiatorID string
	createdAt   time.Time
}

// pendingPunch tracks a scheduled P2P-first fallback for an initiator that is
// waiting for its target to complete hole punching (issue #157). When the
// target responds with PunchHoleSent in time, handlePunchHoleSent cancels the
// fallback and the genuine PunchHoleResponse (carrying the target's punched
// address) is delivered. Otherwise the fallback fires, delivering a
// relay-capable response so the client can fall back to relay instead of
// hanging.
type pendingPunch struct {
	timer     *time.Timer
	fired     atomic.Bool
	createdAt time.Time
}

// writeProto sends a protobuf message, using encryption if the connection is secure.
func (pc *tcpPunchConn) writeProto(msg *pb.RendezvousMessage) error {
	pc.writeMu.Lock()
	defer pc.writeMu.Unlock()
	if pc.secure != nil {
		return pc.secure.WriteMessage(msg)
	}
	return codec.WriteRawProto(pc.conn, msg)
}

// tcpPunchConnForPeer returns a keep-alive TCP signal connection bound to peerID
// (RegisterPk / punch session). Used to deliver PunchHole/RequestRelay to
// TCP-only targets that have no UDP heartbeat.
func (s *Server) tcpPunchConnForPeer(peerID string) *tcpPunchConn {
	if s == nil || peerID == "" {
		return nil
	}
	var found *tcpPunchConn
	s.tcpPunchConns.Range(func(_, value any) bool {
		pc, ok := value.(*tcpPunchConn)
		if ok && pc != nil && pc.peerID == peerID {
			found = pc
			return false
		}
		return true
	})
	return found
}

// Server is the main signal server instance.
type Server struct {
	cfg       *config.Config
	kp        *crypto.KeyPair
	db        db.Database
	peers     *peer.Map
	blocklist *security.Blocklist
	limiter   *ratelimit.IPLimiter
	eventBus  *events.Bus
	auditLog  *audit.Logger
	udpConn   *net.UDPConn
	tcpLn     net.Listener
	natLn     net.Listener
	wsHTTP    *http.Server // WebSocket signal listener
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup

	// tcpPunchConns maps remote-addr string → *tcpPunchConn for initiator TCP
	// connections that are waiting in a keep-alive loop (PunchHoleRequest).
	// When a target sends a RelayResponse, we decode socket_addr to find the
	// initiator's addr key and forward the message over their TCP connection.
	tcpPunchConns sync.Map // map[string]*tcpPunchConn

	// wsPunchConns maps normalizeAddrKey(ip:port) → *codec.WSConn for WebSocket
	// initiators waiting for async PunchHole/RelayResponse (#276). Exact port
	// matching avoids delivering signed PKs to the wrong peer behind shared NAT.
	wsPunchConns sync.Map // map[string]*codec.WSConn

	// pendingRelayUUIDs tracks relay session correlation by target + initiator
	// endpoint (#399). Key=targetID + initiator endpoint, Value=*pendingUUID.
	// Including the endpoint prevents parallel sessions to one target from
	// borrowing each other's UUID / initiator identity.
	pendingRelayUUIDs sync.Map // map[string]*pendingUUID

	// pendingRelayByUUID indexes the same pendingUUID entries by relay UUID so
	// RelayResponse can recover target/initiator when socket_addr correlation
	// is incomplete (#399).
	pendingRelayByUUID sync.Map // map[string]*pendingUUID

	// pendingPunches tracks P2P-first fallback timers per initiator address
	// (issue #157). Key=normalizeAddrKey(initiatorAddr), Value=*pendingPunch.
	pendingPunches sync.Map // map[string]*pendingPunch

	// lastSharedNATWarnUnixNano rate-limits SAME_NAT_RELAY=false warnings (#399).
	lastSharedNATWarnUnixNano atomic.Int64

	// localIP is the server's detected public IP address (via external service).
	// Used to build the relay server address when -relay-servers is not set.
	localIP atomic.Value // stores string

	// lanIP is the server's local/private IP address (from OS routing table).
	// Used for LAN relay advertisements when both peers are on the same network.
	lanIP atomic.Value // stores string

	// lanNet is the optional LAN CIDR from MASK / -mask (issue #404). When nil,
	// peer subnet checks fall back to the historic IPv4 /24 comparison.
	lanNet *net.IPNet

	// networkPolicy resolves org-level block_direct_p2p / allowed relay servers.
	networkPolicy *policy.NetworkResolver

	billing *billing.Service
}

// New creates a new signal server instance.
func New(cfg *config.Config, kp *crypto.KeyPair, database db.Database) *Server {
	s := &Server{
		cfg:           cfg,
		kp:            kp,
		db:            database,
		peers:         peer.NewMap(),
		eventBus:      events.NewBus(),
		networkPolicy: policy.NewNetworkResolver(database),
	}
	if cfg != nil {
		s.lanNet = parseLANMask(cfg.Mask)
	}
	return s
}

// parseLANMask parses MASK / -mask (e.g. "192.168.0.0/16"). Empty or invalid
// values yield nil so callers keep the default /24 LAN detection behaviour.
func parseLANMask(mask string) *net.IPNet {
	mask = strings.TrimSpace(mask)
	if mask == "" {
		return nil
	}
	_, network, err := net.ParseCIDR(mask)
	if err != nil {
		log.Printf("[signal] WARN: invalid MASK %q (%v); falling back to /24 LAN detection", mask, err)
		return nil
	}
	log.Printf("[signal] LAN MASK configured: %s", network.String())
	return network
}

// SetBlocklist sets the blocklist used by the signal server.
func (s *Server) SetBlocklist(bl *security.Blocklist) {
	s.blocklist = bl
}

// SetRateLimiter sets the IP rate limiter used by the signal server.
func (s *Server) SetRateLimiter(l *ratelimit.IPLimiter) {
	s.limiter = l
}

// SetAuditLogger sets the audit logger used by the signal server. Rejected
// registration attempts (soft-deleted, banned, enrollment policy, renamed ID)
// are recorded so administrators have forensic visibility (GHSA-3v82-3gf8-fxx8).
func (s *Server) SetAuditLogger(l *audit.Logger) {
	s.auditLog = l
}

// SetBillingService attaches commercialization billing gates to signal handling.
func (s *Server) SetBillingService(b *billing.Service) {
	s.billing = b
}

// PeerMap returns the server's in-memory peer map for external access (e.g., API).
func (s *Server) PeerMap() *peer.Map {
	return s.peers
}

// EventBus returns the server's event bus for external access (e.g., API WebSocket).
func (s *Server) EventBus() *events.Bus {
	return s.eventBus
}

// detectLocalIP discovers the server's public IP address for relay advertisements.
// Priority:
//  1. Try external service (checkip.amazonaws.com) to get public IP
//  2. Fall back to OS routing table (outbound UDP socket local addr)
//
// The result is stored in s.localIP for use by getRelayServer().
func (s *Server) detectLocalIP() {
	// Always detect LAN IP via OS routing table (needed for LAN relay).
	conn, err := net.Dial("udp4", "8.8.8.8:53")
	if err == nil {
		localAddr := conn.LocalAddr().(*net.UDPAddr)
		lanIP := localAddr.IP.String()
		s.lanIP.Store(lanIP)
		conn.Close()
		log.Printf("[signal] Detected LAN IP: %s (used for local relay advertisements)", lanIP)
	}

	// Try to detect public IP via external HTTP service.
	if ip := detectPublicIP(); ip != "" {
		s.localIP.Store(ip)
		log.Printf("[signal] Detected public IP: %s (used for relay advertisements)", ip)
		return
	}

	// Fallback: use LAN IP as public IP too
	if ip, ok := s.lanIP.Load().(string); ok && ip != "" {
		s.localIP.Store(ip)
		log.Printf("[signal] WARN: No public IP detected, using LAN IP: %s", ip)
		log.Printf("[signal] WARN: Remote relay connections will fail! Set -relay-servers YOUR.PUBLIC.IP or RELAY_SERVERS env var.")
	} else {
		log.Printf("[signal] WARN: Failed to detect any IP address. Relay connections will fail!")
		log.Printf("[signal] WARN: Set -relay-servers YOUR.PUBLIC.IP or RELAY_SERVERS env var.")
	}
}

// startIPDetectionRetry periodically retries public IP detection in background
// if the initial detection failed (no explicit -relay-servers and no public IP).
func (s *Server) startIPDetectionRetry(ctx context.Context) {
	// Skip retry if relay servers are explicitly configured
	if len(s.cfg.GetRelayServers()) > 0 {
		return
	}
	// Skip if we already have a public IP (not a LAN IP)
	if ip, ok := s.localIP.Load().(string); ok && ip != "" {
		if lanIP, ok2 := s.lanIP.Load().(string); ok2 && ip != lanIP {
			return // Already have a public IP different from LAN IP
		}
	}

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ip := detectPublicIP(); ip != "" {
					old, _ := s.localIP.Load().(string)
					if old != ip {
						s.localIP.Store(ip)
						log.Printf("[signal] Public IP detected (retry): %s (relay address updated)", ip)
					}
					return // Stop retrying once successful
				}
			}
		}
	}()
}

// detectPublicIP tries to determine the server's public IP address by querying
// external services. Tries HTTPS first, then HTTP fallbacks for environments
// where outbound HTTPS is blocked. Returns empty string on failure.
func detectPublicIP() string {
	client := &http.Client{Timeout: 5 * time.Second}

	// Try HTTPS first, then HTTP fallbacks (some servers block outbound HTTPS)
	services := []string{
		"https://checkip.amazonaws.com",
		"https://api.ipify.org",
		"https://ifconfig.me/ip",
		"http://checkip.amazonaws.com",
		"http://api.ipify.org",
		"http://ifconfig.me/ip",
	}

	for _, svc := range services {
		resp, err := client.Get(svc)
		if err != nil {
			continue
		}
		body := make([]byte, 64)
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		if n > 0 && resp.StatusCode == 200 {
			ip := strings.TrimSpace(string(body[:n]))
			// Validate it looks like an IP address
			if parsed := net.ParseIP(ip); parsed != nil {
				return ip
			}
		}
	}
	return ""
}

// Start launches all signal server listeners and the heartbeat cleaner.
func (s *Server) Start(ctx context.Context) error {
	s.ctx, s.cancel = context.WithCancel(ctx)

	// Start UDP listener on signal port (main signal traffic)
	udpAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf(":%d", s.cfg.SignalPort))
	if err != nil {
		return fmt.Errorf("signal: resolve UDP addr: %w", err)
	}
	s.udpConn, err = net.ListenUDP("udp", udpAddr)
	if err != nil {
		return fmt.Errorf("signal: listen UDP :%d: %w", s.cfg.SignalPort, err)
	}
	log.Printf("[signal] UDP listening on :%d", s.cfg.SignalPort)

	// Detect the server's outbound IP address for relay advertisements.
	// This is used when -relay-servers is not explicitly set.
	s.detectLocalIP()

	// Start TCP listener on signal port (TCP fallback for signal)
	s.tcpLn, err = net.Listen("tcp", fmt.Sprintf(":%d", s.cfg.SignalPort))
	if err != nil {
		return fmt.Errorf("signal: listen TCP :%d: %w", s.cfg.SignalPort, err)
	}

	// Phase 3: Wrap TCP signal listener with dual-mode TLS if enabled.
	// Dual-mode auto-detects TLS ClientHello (0x16) vs plain protobuf,
	// allowing both legacy and TLS clients on the same port.
	if s.cfg.SignalTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("signal: %w", err)
		}
		s.tcpLn = config.NewDualModeListener(s.tcpLn, tlsCfg)
		log.Printf("[signal] TCP+TLS (dual-mode) listening on :%d", s.cfg.SignalPort)
	} else {
		log.Printf("[signal] TCP listening on :%d", s.cfg.SignalPort)
	}

	// Start NAT test listener on signal port - 1 (TCP 21115)
	s.natLn, err = net.Listen("tcp", fmt.Sprintf(":%d", s.cfg.NATTestPort()))
	if err != nil {
		return fmt.Errorf("signal: listen NAT TCP :%d: %w", s.cfg.NATTestPort(), err)
	}

	// Phase 3: Wrap NAT test listener with dual-mode TLS if enabled.
	if s.cfg.SignalTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("signal: NAT TLS: %w", err)
		}
		s.natLn = config.NewDualModeListener(s.natLn, tlsCfg)
		log.Printf("[signal] NAT test TCP+TLS (dual-mode) listening on :%d", s.cfg.NATTestPort())
	} else {
		log.Printf("[signal] NAT test/online TCP listening on :%d", s.cfg.NATTestPort())
	}

	// Start background public IP detection retry if initial detection failed
	s.startIPDetectionRetry(s.ctx)

	// Launch goroutines
	s.wg.Add(6)
	go s.serveUDP()
	go s.serveTCP()
	go s.serveNAT()
	go s.serveWS()
	go s.heartbeatCleaner()
	go s.cleanupTCPPunchConns()
	s.startPeerIDChangeListener()
	s.maybeWarnSharedNATRelayDisabled()

	return nil
}

// Stop gracefully shuts down all signal server listeners.
func (s *Server) Stop() {
	log.Printf("[signal] Shutting down...")
	s.cancel()

	if s.udpConn != nil {
		s.udpConn.Close()
	}
	if s.tcpLn != nil {
		s.tcpLn.Close()
	}
	if s.natLn != nil {
		s.natLn.Close()
	}
	if s.wsHTTP != nil {
		s.wsHTTP.Shutdown(context.Background())
	}

	s.wg.Wait()
	log.Printf("[signal] Stopped")
}

// serveUDP reads datagrams from the UDP socket and dispatches them.
func (s *Server) serveUDP() {
	defer s.wg.Done()

	buf := make([]byte, 65536)
	for {
		n, raddr, err := s.udpConn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				log.Printf("[signal] UDP read error: %v", err)
				continue
			}
		}

		msg := &pb.RendezvousMessage{}
		if err := proto.Unmarshal(buf[:n], msg); err != nil {
			log.Printf("[signal] UDP unmarshal from %s: %v", raddr, err)
			continue
		}

		s.handleUDPMessage(msg, raddr)
	}
}

// serveTCP accepts TCP connections and handles framed signal messages.
// M4: TCP connections are rate-limited per IP, same as UDP registrations.
func (s *Server) serveTCP() {
	defer s.wg.Done()

	for {
		conn, err := s.tcpLn.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				// Filter noisy but harmless accept errors (scanners, TLS probes, resets)
				if errors.Is(err, io.EOF) ||
					strings.Contains(err.Error(), "connection reset") ||
					strings.Contains(err.Error(), "use of closed") {
					continue
				}
				log.Printf("[signal] TCP accept error: %v", err)
				continue
			}
		}

		// M4: Rate-limit TCP signal connections per IP to prevent resource exhaustion.
		if s.limiter != nil {
			host, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
			if !s.allowSignalConnection(host) {
				conn.Close()
				continue
			}
		}

		go s.handleTCPConn(conn)
	}
}

// normalizeAddrKey produces a canonical "ip:port" string suitable for use as
// a map key.  IPv4-mapped IPv6 addresses like [::ffff:1.2.3.4] are reduced to
// their IPv4 form so that TCP and UDP representations of the same endpoint
// always match.
func normalizeAddrKey(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return addr
	}
	if ip4 := ip.To4(); ip4 != nil {
		return net.JoinHostPort(ip4.String(), port)
	}
	return addr
}

// handleTCPConn handles a single TCP signal connection.
// Matches Rust hbbs behavior: reads framed protobuf in a loop.
// PunchHoleRequest, RequestRelay, and RegisterPk keep the connection alive
// (RegisterPk so #327 viewer-only PunchHole can use tcpSessionPeerID on the
// same session); other message types close after handling.
//
// When in keep-alive mode the connection is registered in tcpPunchConns so that
// RelayResponse messages from the target peer can be forwarded here.  Go's
// net.Conn supports concurrent Read+Write, and we use tcpPunchConn.writeMu to
// serialise writes from both the main loop and the forwarder.
func (s *Server) handleTCPConn(conn net.Conn) {
	defer conn.Close()

	rawAddr := conn.RemoteAddr().String()
	addrKey := normalizeAddrKey(rawAddr)

	// Attempt secure TCP handshake (KeyExchange).
	// New clients (≥1.2.x) expect the server to send a KeyExchange first.
	// Old clients will simply send a protobuf message which we detect and
	// process directly without encryption.
	result, err := crypto.NegotiateSecureTCP(conn, s.kp.PrivateKey)
	if err != nil {
		if !isNormalClose(err) {
			log.Printf("[signal] TCP handshake with %s failed: %v", addrKey, err)
		}
		return
	}

	if result.Secure {
		log.Printf("[signal] Secure TCP session with %s", addrKey)
		s.handleSecureTCPConn(result.SecureConn, addrKey)
	} else {
		log.Printf("[signal] Plain TCP session with %s", addrKey)
		s.handlePlainTCPConn(conn, addrKey, result.FirstMsg)
	}
}

// handleSecureTCPConn handles a TCP connection with NaCl encryption active.
func (s *Server) handleSecureTCPConn(sc *crypto.SecureTCPConn, addrKey string) {
	pc := &tcpPunchConn{conn: sc, secure: sc, createdAt: time.Now()}
	registered := false
	defer func() {
		if registered {
			s.tcpPunchConns.Delete(addrKey)
			log.Printf("[signal] TCP punch conn unregistered: %s (secure)", addrKey)
		}
	}()

	for {
		msg, err := sc.ReadMessage(30 * time.Second)
		if err != nil {
			if !isNormalClose(err) {
				log.Printf("[signal] Secure TCP read from %s: %v", addrKey, err)
			}
			return
		}

		if skip, closeConn := s.handleEmptyOrUnknownUnion(msg, addrKey, true); skip {
			if closeConn {
				return
			}
			continue
		}

		keepAlive := s.logAndCheckKeepAlive(msg, addrKey, true)

		if keepAlive && !registered {
			s.tcpPunchConns.Store(addrKey, pc)
			registered = true
			log.Printf("[signal] TCP punch conn registered: %s (secure)", addrKey)
		}

		resp := s.handleMessage(msg, sc.RemoteAddr())
		if resp != nil {
			if err := pc.writeProto(resp); err != nil {
				log.Printf("[signal] Secure TCP write to %s: %v", addrKey, err)
				return
			}
		}

		if !keepAlive {
			return
		}
	}
}

// handlePlainTCPConn handles a plain (unencrypted) TCP connection — used by
// old clients that don't perform KeyExchange.
func (s *Server) handlePlainTCPConn(conn net.Conn, addrKey string, firstMsg *pb.RendezvousMessage) {
	pc := &tcpPunchConn{conn: conn, createdAt: time.Now()}
	registered := false
	defer func() {
		if registered {
			s.tcpPunchConns.Delete(addrKey)
			log.Printf("[signal] TCP punch conn unregistered: %s", addrKey)
		}
	}()

	// Process the first message that was already read during handshake.
	if firstMsg != nil {
		if skip, closeConn := s.handleEmptyOrUnknownUnion(firstMsg, addrKey, false); skip {
			if closeConn {
				return
			}
		} else {
			keepAlive := s.logAndCheckKeepAlive(firstMsg, addrKey, false)

			if keepAlive && !registered {
				s.tcpPunchConns.Store(addrKey, pc)
				registered = true
				log.Printf("[signal] TCP punch conn registered: %s", addrKey)
			}

			resp := s.handleMessage(firstMsg, conn.RemoteAddr())
			if resp != nil {
				if err := pc.writeProto(resp); err != nil {
					log.Printf("[signal] TCP write to %s: %v", addrKey, err)
					return
				}
			}

			if !keepAlive {
				return
			}
		}
	}

	// Continue reading subsequent messages.
	for {
		msg, err := codec.ReadRawProto(conn, 30*time.Second)
		if err != nil {
			if !isNormalClose(err) {
				log.Printf("[signal] TCP read from %s: %v", addrKey, err)
			}
			return
		}

		if skip, closeConn := s.handleEmptyOrUnknownUnion(msg, addrKey, false); skip {
			if closeConn {
				return
			}
			continue
		}

		keepAlive := s.logAndCheckKeepAlive(msg, addrKey, false)

		if keepAlive && !registered {
			s.tcpPunchConns.Store(addrKey, pc)
			registered = true
			log.Printf("[signal] TCP punch conn registered: %s", addrKey)
		}

		resp := s.handleMessage(msg, conn.RemoteAddr())
		if resp != nil {
			if err := pc.writeProto(resp); err != nil {
				log.Printf("[signal] TCP write to %s: %v", addrKey, err)
				return
			}
		}

		if !keepAlive {
			return
		}
	}
}

// handleEmptyOrUnknownUnion handles RendezvousMessage with Union==nil.
// Returns (skip, closeConn):
//   - empty message (no unknown fields): soft-ignore keepalive → skip=true, closeConn=false
//   - unknown protobuf fields (schema drift): log field numbers → skip=true, closeConn=true
//   - Union set: skip=false (caller should dispatch normally)
func (s *Server) handleEmptyOrUnknownUnion(msg *pb.RendezvousMessage, addrKey string, secure bool) (skip, closeConn bool) {
	if msg == nil || msg.Union != nil {
		return false, false
	}
	tag := ""
	if secure {
		tag = " (secure)"
	}
	unknown := msg.ProtoReflect().GetUnknown()
	if len(unknown) == 0 {
		// Encrypted empty ping (or empty protobuf) — keep the connection (#296 / WS-style).
		return true, false
	}
	nums := unknownProtobufFieldNumbers(unknown)
	log.Printf("[signal] TCP msg from %s%s: empty Union with unknown protobuf fields %v (%d unknown bytes)",
		addrKey, tag, nums, len(unknown))
	return true, true
}

// logAndCheckKeepAlive logs the message type and returns true if the message
// type should keep the TCP connection alive for forwarding.
func (s *Server) logAndCheckKeepAlive(msg *pb.RendezvousMessage, addrKey string, secure bool) bool {
	tag := ""
	if secure {
		tag = " (secure)"
	}

	switch {
	case msg.GetPunchHoleRequest() != nil:
		log.Printf("[signal] TCP msg from %s%s: PunchHoleRequest (target=%s)", addrKey, tag, msg.GetPunchHoleRequest().Id)
		return true
	case msg.GetRequestRelay() != nil:
		log.Printf("[signal] TCP msg from %s%s: RequestRelay (target=%s, uuid=%s)", addrKey, tag, msg.GetRequestRelay().Id, msg.GetRequestRelay().Uuid)
		return true
	case msg.GetRegisterPk() != nil:
		log.Printf("[signal] TCP msg from %s%s: RegisterPk (id=%s)", addrKey, tag, msg.GetRegisterPk().Id)
		// Keep alive so bindTCPSessionPeer + a following PunchHole/RequestRelay
		// on this connection can authorize without IP-only FindByIP (#302/#327).
		return true
	case msg.GetFetchLocalAddr() != nil:
		log.Printf("[signal] TCP msg from %s%s: FetchLocalAddr", addrKey, tag)
	case msg.GetLocalAddr() != nil:
		log.Printf("[signal] TCP msg from %s%s: LocalAddr (id=%s)", addrKey, tag, msg.GetLocalAddr().Id)
	case msg.GetRelayResponse() != nil:
		log.Printf("[signal] TCP msg from %s%s: RelayResponse (uuid=%s, id=%s)", addrKey, tag, msg.GetRelayResponse().Uuid, msg.GetRelayResponse().GetId())
		return true
	case msg.GetPunchHoleSent() != nil:
		log.Printf("[signal] TCP msg from %s%s: PunchHoleSent (id=%s)", addrKey, tag, msg.GetPunchHoleSent().Id)
		return true
	case msg.GetPunchHoleResponse() != nil:
		log.Printf("[signal] TCP msg from %s%s: PunchHoleResponse", addrKey, tag)
	case msg.GetTestNatRequest() != nil:
		log.Printf("[signal] TCP msg from %s%s: TestNatRequest", addrKey, tag)
	case msg.GetHc() != nil:
		// don't log health checks
	case msg.GetHttpProxyRequest() != nil:
		req := msg.GetHttpProxyRequest()
		log.Printf("[signal] TCP msg from %s%s: HttpProxyRequest (method=%s path=%s)", addrKey, tag, req.GetMethod(), req.GetPath())
	default:
		log.Printf("[signal] TCP msg from %s%s: unhandled type %T", addrKey, tag, msg.Union)
	}
	return false
}

// unknownProtobufFieldNumbers extracts distinct field numbers from raw unknown protobuf bytes.
func unknownProtobufFieldNumbers(b []byte) []int32 {
	var nums []int32
	seen := map[protowire.Number]struct{}{}
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			break
		}
		b = b[n:]
		n = protowire.ConsumeFieldValue(num, typ, b)
		if n < 0 {
			break
		}
		b = b[n:]
		if _, ok := seen[num]; ok {
			continue
		}
		seen[num] = struct{}{}
		nums = append(nums, int32(num))
	}
	return nums
}

// forwardToTCPInitiator looks up the initiator's TCP connection by address
// (decoded from RelayResponse.SocketAddr) and forwards the message.
//
// In Rust hbbs, send_to_tcp_sync removes the sink and drops it (closing the
// write-half).  However, RustDesk clients may not handle a half-closed TCP
// connection gracefully — they can interpret the FIN as an error instead of
// cleanly reading the response and proceeding to relay.  So we keep the
// connection open and let it time out naturally via the handleTCPConn read loop
// (30s timeout) or when the client closes its side.
func (s *Server) forwardToTCPInitiator(initiatorAddr string, msg *pb.RendezvousMessage) bool {
	normAddr := normalizeAddrKey(initiatorAddr)
	val, ok := s.tcpPunchConns.Load(normAddr)
	if !ok {
		return false
	}
	pc := val.(*tcpPunchConn)
	if err := pc.writeProto(msg); err != nil {
		log.Printf("[signal] TCP forward write to %s: %v", initiatorAddr, err)
		return false
	}
	return true
}

// forwardToInitiator delivers an async punch/relay message to the initiator
// over TCP (tcpPunchConns) or WebSocket (wsPunchConns / unique-IP fallback).
// Required for WSS clients behind reverse proxies which are never registered
// in tcpPunchConns (#276).
func (s *Server) forwardToInitiator(initiatorAddr string, msg *pb.RendezvousMessage) bool {
	if s.forwardToTCPInitiator(initiatorAddr, msg) {
		return true
	}
	if s.forwardToWSInitiator(initiatorAddr, msg) {
		return true
	}
	log.Printf("[signal] initiator forwarding: no TCP/WS conn for key %q (raw=%q)",
		normalizeAddrKey(initiatorAddr), initiatorAddr)
	return false
}

// registerWSPunchConn stores a WebSocket connection under its full ip:port key
// so async PunchHole/RelayResponse can be delivered without IP-only ambiguity.
func (s *Server) registerWSPunchConn(addr string, wsc *codec.WSConn) {
	if wsc == nil || addr == "" {
		return
	}
	key := normalizeAddrKey(addr)
	s.wsPunchConns.Store(key, wsc)
}

// unregisterWSPunchConn removes the punch-map entry only if it still points at wsc.
func (s *Server) unregisterWSPunchConn(addr string, wsc *codec.WSConn) {
	if wsc == nil || addr == "" {
		return
	}
	key := normalizeAddrKey(addr)
	if val, ok := s.wsPunchConns.Load(key); ok {
		if existing, ok := val.(*codec.WSConn); ok && existing == wsc {
			s.wsPunchConns.Delete(key)
		}
	}
}

// forwardToWSInitiator delivers msg to a WebSocket initiator using the exact
// ip:port key first. Falls back to FindWSByIP only when exactly one WS peer
// shares that IP (legacy register-only sessions).
func (s *Server) forwardToWSInitiator(initiatorAddr string, msg *pb.RendezvousMessage) bool {
	normAddr := normalizeAddrKey(initiatorAddr)
	if val, ok := s.wsPunchConns.Load(normAddr); ok {
		wsc, ok := val.(*codec.WSConn)
		if !ok || wsc == nil {
			s.wsPunchConns.Delete(normAddr)
			return false
		}
		if err := wsc.WriteMessage(msg); err != nil {
			if isNormalClose(err) || strings.Contains(err.Error(), "use of closed network connection") {
				s.wsPunchConns.Delete(normAddr)
				return false
			}
			log.Printf("[signal] WS punch forward write to %s: %v", initiatorAddr, err)
			return false
		}
		return true
	}

	host, _, err := net.SplitHostPort(normAddr)
	if err != nil {
		host = normAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if s.peers.CountWSByIP(ip) != 1 {
		return false
	}
	entry := s.peers.FindWSByIP(ip)
	if entry == nil || entry.WSConn == nil {
		return false
	}
	wsc, ok := entry.WSConn.(*codec.WSConn)
	if !ok {
		return false
	}
	if err := wsc.WriteMessage(msg); err != nil {
		if isNormalClose(err) || strings.Contains(err.Error(), "use of closed network connection") {
			entry.WSConn = nil
			return false
		}
		log.Printf("[signal] WS forward write to peer %s (addr=%s): %v", entry.ID, initiatorAddr, err)
		return false
	}
	return true
}

// serveNAT accepts TCP connections on the NAT test port (21115).
// Handles TestNatRequest and OnlineRequest.
func (s *Server) serveNAT() {
	defer s.wg.Done()

	for {
		conn, err := s.natLn.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				log.Printf("[signal] NAT accept error: %v", err)
				continue
			}
		}
		go s.handleNATConn(conn)
	}
}

// handleNATConn handles a single NAT test / online query connection.
// Uses raw protobuf (no framing header) matching RustDesk's FramedStream/BytesCodec.
func (s *Server) handleNATConn(conn net.Conn) {
	defer conn.Close()

	msg, err := codec.ReadRawProto(conn, 30*time.Second)
	if err != nil {
		return
	}

	var resp *pb.RendezvousMessage

	switch {
	case msg.GetTestNatRequest() != nil:
		resp = s.handleTestNat(msg.GetTestNatRequest(), conn.RemoteAddr())
	case msg.GetOnlineRequest() != nil:
		resp = s.handleOnlineRequest(msg.GetOnlineRequest())
	default:
		log.Printf("[signal] NAT port: unexpected message type from %s", conn.RemoteAddr())
		return
	}

	if resp != nil {
		if err := codec.WriteRawProto(conn, resp); err != nil {
			log.Printf("[signal] NAT write to %s: %v", conn.RemoteAddr(), err)
		}
	}
}

// heartbeatCleaner periodically checks heartbeat status for all peers,
// transitions them through status tiers (ONLINE→DEGRADED→CRITICAL→OFFLINE),
// and removes peers that have fully expired.
func (s *Server) heartbeatCleaner() {
	defer s.wg.Done()

	ticker := time.NewTicker(config.HeartbeatCheck)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			// Phase 1: Check heartbeats and transition status tiers
			degraded, critical := s.peers.CheckHeartbeats(
				config.HeartbeatExpected,
				config.DegradedThreshold,
				config.CriticalThreshold,
			)

			// Update database for peers that transitioned to DEGRADED
			if len(degraded) > 0 {
				if err := s.db.BatchUpdatePeerStatus(degraded, "DEGRADED"); err != nil {
					log.Printf("[signal] Failed to mark %d peers degraded: %v", len(degraded), err)
				}
				for _, id := range degraded {
					log.Printf("[signal] Peer %s → DEGRADED (missed heartbeats)", id)
					s.eventBus.Publish(events.Event{
						Type: events.EventPeerDegraded,
						Data: map[string]string{"id": id},
					})
				}
			}

			// Update database for peers that transitioned to CRITICAL
			if len(critical) > 0 {
				if err := s.db.BatchUpdatePeerStatus(critical, "CRITICAL"); err != nil {
					log.Printf("[signal] Failed to mark %d peers critical: %v", len(critical), err)
				}
				for _, id := range critical {
					log.Printf("[signal] Peer %s → CRITICAL (about to go offline)", id)
					s.eventBus.Publish(events.Event{
						Type: events.EventPeerCritical,
						Data: map[string]string{"id": id},
					})
				}
			}

			// Phase 2: Remove fully expired peers (offline)
			expired := s.peers.CleanExpired(config.RegTimeout)
			if len(expired) > 0 {
				if err := s.db.BatchUpdatePeerStatus(expired, "OFFLINE"); err != nil {
					log.Printf("[signal] Failed to mark %d peers offline: %v", len(expired), err)
				}
				for _, id := range expired {
					s.eventBus.Publish(events.Event{
						Type: events.EventPeerOffline,
						Data: map[string]string{"id": id},
					})
				}
				log.Printf("[signal] Cleaned %d expired peers (→ OFFLINE)", len(expired))
			}
		}
	}
}

// cleanupTCPPunchConns periodically evicts stale entries from tcpPunchConns.
// M2: Prevents memory exhaustion from abandoned TCP connections that the
// handler goroutine didn't clean up (e.g., stuck io.Read, goroutine leak).
// Also enforces a hard cap on total entries to mitigate DDoS.
func (s *Server) cleanupTCPPunchConns() {
	defer s.wg.Done()

	const (
		maxTTL     = 2 * time.Minute // hard TTL per entry (well beyond 30s read timeout)
		maxEntries = 10000           // hard cap on total pending connections
	)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			count := 0
			evicted := 0

			s.tcpPunchConns.Range(func(key, value any) bool {
				count++
				pc := value.(*tcpPunchConn)

				// Evict entries older than maxTTL
				if now.Sub(pc.createdAt) > maxTTL {
					s.tcpPunchConns.Delete(key)
					pc.conn.Close()
					evicted++
					return true
				}

				// If over capacity, evict oldest first (simple approach: evict all over TTL/2)
				if count > maxEntries && now.Sub(pc.createdAt) > maxTTL/2 {
					s.tcpPunchConns.Delete(key)
					pc.conn.Close()
					evicted++
				}

				return true
			})

			if evicted > 0 {
				log.Printf("[signal] TCP punch conns cleanup: evicted %d stale entries (remaining ~%d)", evicted, count-evicted)
			}

			// Also cleanup stale pendingRelayUUIDs (same TTL as punch conns)
			uuidEvicted := 0
			s.pendingRelayUUIDs.Range(func(key, value any) bool {
				pu := value.(*pendingUUID)
				if now.Sub(pu.createdAt) > maxTTL {
					s.pendingRelayUUIDs.Delete(key)
					if pu.uuid != "" {
						s.pendingRelayByUUID.Delete(pu.uuid)
					}
					uuidEvicted++
				}
				return true
			})
			if uuidEvicted > 0 {
				log.Printf("[signal] Pending relay UUIDs cleanup: evicted %d stale entries", uuidEvicted)
			}

			s.maybeWarnSharedNATRelayDisabled()

			// Safety sweep for pendingPunches (issue #157). Entries normally
			// self-remove when the fallback fires or is cancelled; this only
			// reclaims orphans left by abnormal shutdown paths.
			punchEvicted := 0
			s.pendingPunches.Range(func(key, value any) bool {
				pp := value.(*pendingPunch)
				if now.Sub(pp.createdAt) > maxTTL {
					if val, ok := s.pendingPunches.LoadAndDelete(key); ok {
						if stale, ok := val.(*pendingPunch); ok {
							stale.fired.Store(true)
							stale.timer.Stop()
						}
					}
					punchEvicted++
				}
				return true
			})
			if punchEvicted > 0 {
				log.Printf("[signal] Pending punches cleanup: evicted %d stale entries", punchEvicted)
			}
		}
	}
}

// sendUDP sends a protobuf message to a UDP address. Returns false when the
// UDP socket is unavailable or the write fails (tests often have a nil udpConn).
func (s *Server) sendUDP(msg *pb.RendezvousMessage, addr *net.UDPAddr) bool {
	if s == nil || s.udpConn == nil || msg == nil || addr == nil {
		return false
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		log.Printf("[signal] marshal error: %v", err)
		return false
	}
	if _, err := s.udpConn.WriteToUDP(data, addr); err != nil {
		log.Printf("[signal] UDP send to %s: %v", addr, err)
		return false
	}
	return true
}

// pendingRelayKey isolates a target's relay session by the initiator endpoint.
// RustDesk's socket_addr is the only stable correlation field available from
// old clients that omit the UUID in RelayResponse.
func pendingRelayKey(targetID string, initiatorAddr *net.UDPAddr) string {
	if initiatorAddr == nil {
		return targetID + "\x00"
	}
	return targetID + "\x00" + normalizeAddrKey(initiatorAddr.String())
}

// storePendingUUID stores relay session correlation for later RelayResponse
// forwarding (#399). uuid may be empty when PunchHole has not minted a relay
// ticket yet; initiatorID should still be recorded so the reverse path does
// not resolve via FindByIP on shared NAT.
func (s *Server) storePendingUUID(targetID string, initiatorAddr *net.UDPAddr, uuid, initiatorID string) {
	if targetID == "" && uuid == "" {
		return
	}
	key := pendingRelayKey(targetID, initiatorAddr)
	entry := &pendingUUID{
		uuid:        uuid,
		targetID:    targetID,
		initiatorID: initiatorID,
		createdAt:   time.Now(),
	}
	// Merge with an existing entry for the same endpoint so a later UUID
	// fill-in does not wipe initiator identity (or vice versa).
	if prev, ok := s.pendingRelayUUIDs.Load(key); ok {
		if old, ok := prev.(*pendingUUID); ok && old != nil {
			if entry.uuid == "" {
				entry.uuid = old.uuid
			}
			if entry.initiatorID == "" {
				entry.initiatorID = old.initiatorID
			}
			if entry.targetID == "" {
				entry.targetID = old.targetID
			}
			if old.uuid != "" && old.uuid != entry.uuid {
				s.pendingRelayByUUID.Delete(old.uuid)
			}
		}
	}
	s.pendingRelayUUIDs.Store(key, entry)
	if entry.uuid != "" {
		s.pendingRelayByUUID.Store(entry.uuid, entry)
	}
}

// getPendingRelay returns the pending session for target + initiator endpoint.
func (s *Server) getPendingRelay(targetID string, initiatorAddr *net.UDPAddr) *pendingUUID {
	if val, ok := s.pendingRelayUUIDs.Load(pendingRelayKey(targetID, initiatorAddr)); ok {
		if pu, ok := val.(*pendingUUID); ok {
			return pu
		}
	}
	return nil
}

// getPendingUUID retrieves the pending UUID for a target device (without removing it).
// The UUID remains available for subsequent retry attempts; cleanup happens via ticker.
// Returns empty string if no pending UUID exists for this target and initiator.
func (s *Server) getPendingUUID(targetID string, initiatorAddr *net.UDPAddr) string {
	if pu := s.getPendingRelay(targetID, initiatorAddr); pu != nil {
		return pu.uuid
	}
	return ""
}

// getPendingRelayByUUID looks up a pending session by relay UUID (#399).
func (s *Server) getPendingRelayByUUID(uuid string) *pendingUUID {
	if uuid == "" {
		return nil
	}
	if val, ok := s.pendingRelayByUUID.Load(uuid); ok {
		if pu, ok := val.(*pendingUUID); ok {
			return pu
		}
	}
	return nil
}

// maybeWarnSharedNATRelayDisabled logs when SAME_NAT_RELAY is off and several
// live peers share one public IP — a silent failure mode for office NATs (#399).
func (s *Server) maybeWarnSharedNATRelayDisabled() {
	if s == nil || s.cfg == nil || s.cfg.SameNATRelay || s.peers == nil {
		return
	}
	const minInterval = 10 * time.Minute
	now := time.Now().UnixNano()
	if last := s.lastSharedNATWarnUnixNano.Load(); last != 0 && time.Duration(now-last) < minInterval {
		return
	}
	counts := make(map[string]int)
	s.peers.ForEach(func(e *peer.Entry) {
		if e == nil || e.IsExpired(config.RegTimeout) {
			return
		}
		var ip string
		if e.UDPAddr != nil && e.UDPAddr.IP != nil {
			ip = e.UDPAddr.IP.String()
		} else if host, _, err := net.SplitHostPort(e.IP); err == nil {
			ip = host
		} else if e.IP != "" {
			ip = e.IP
		}
		if ip != "" {
			counts[ip]++
		}
	})
	for ip, n := range counts {
		if n < 2 {
			continue
		}
		last := s.lastSharedNATWarnUnixNano.Load()
		if last != 0 && time.Duration(now-last) < minInterval {
			return
		}
		if !s.lastSharedNATWarnUnixNano.CompareAndSwap(last, now) {
			return
		}
		log.Printf("[signal] WARNING: SAME_NAT_RELAY is disabled but %d live peers share public IP %s — same-site sessions often fail without hairpin NAT (issues #121/#399). Enable SAME_NAT_RELAY=Y or -same-nat-relay", n, ip)
		return
	}
}

// schedulePunchFallback registers a delayed P2P-first fallback for an
// initiator (issue #157). After the configured grace period, fallback() runs
// unless cancelPunchFallback is called first (i.e. the target completed hole
// punching and the genuine PunchHoleResponse was delivered). Any pre-existing
// pending punch for the same initiator is replaced.
func (s *Server) schedulePunchFallback(initiatorKey string, fallback func()) {
	delay := time.Duration(s.cfg.P2PFallbackMs) * time.Millisecond
	if delay <= 0 {
		delay = 2 * time.Second
	}
	pp := &pendingPunch{createdAt: time.Now()}
	pp.timer = time.AfterFunc(delay, func() {
		if pp.fired.Swap(true) {
			return
		}
		s.pendingPunches.Delete(initiatorKey)
		fallback()
	})
	if old, loaded := s.pendingPunches.Swap(initiatorKey, pp); loaded {
		if op, ok := old.(*pendingPunch); ok {
			op.fired.Store(true)
			op.timer.Stop()
		}
	}
}

// cancelPunchFallback cancels a scheduled P2P-first fallback for an initiator.
// Returns true if the fallback was cancelled before it could fire.
func (s *Server) cancelPunchFallback(initiatorKey string) bool {
	val, ok := s.pendingPunches.LoadAndDelete(initiatorKey)
	if !ok {
		return false
	}
	pp, ok := val.(*pendingPunch)
	if !ok {
		return false
	}
	if pp.fired.Swap(true) {
		return false // already fired
	}
	pp.timer.Stop()
	return true
}

// isNormalClose returns true if the error represents a normal connection close
// (EOF, timeout, or connection reset by peer). These are expected during
// TCP connection lifecycle and should not be logged as errors.
func isNormalClose(err error) bool {
	if err == nil {
		return false
	}
	if err == io.EOF {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "EOF") ||
		strings.Contains(s, "timeout") ||
		strings.Contains(s, "use of closed network connection") ||
		strings.Contains(s, "connection reset by peer") ||
		strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "connection refused")
}
