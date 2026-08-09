// Package relay implements the BetterDesk relay server (hbbr equivalent).
// It pairs two clients by UUID and creates a bidirectional byte stream between them.
// The relay does NOT parse message.proto content — it's an opaque byte pipe.
package relay

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

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/ratelimit"
)

// Server is the relay server instance.
type Server struct {
	cfg            *config.Config
	bwLimiter      *ratelimit.BandwidthLimiter
	connLimiter    *ratelimit.ConnLimiter
	sessionLimiter *ratelimit.ConnLimiter // active paired sessions per IP (post-pair)
	authorizations *AuthorizationRegistry
	tcpLn          net.Listener
	wsHTTP         *http.Server // WebSocket relay listener
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup

	// Pending connections waiting for a pair (key: UUID string)
	pending sync.Map // map[string]*pendingConn

	// Stats
	ActiveSessions atomic.Int64
	TotalRelayed   atomic.Int64

	onRelayStart func(uuid string)
	onRelayEnd   func(uuid string)
}

// Indirection for testing.
var (
	timeNow   = func() time.Time { return time.Now() }
	timeAfter = func(d time.Duration) <-chan time.Time { return time.After(d) }
)

// relayTransport identifies how a peer reached the relay (framing differs).
// TCP uses RustDesk BytesCodec; WebSocket uses one raw protobuf per binary frame.
// Mixing them after UUID pairing corrupts the E2E handshake (#290).
type relayTransport string

const (
	relayTransportTCP relayTransport = "tcp"
	relayTransportWS  relayTransport = "ws"
)

// pendingConn holds a connection waiting for its pair.
// Exactly one of conn (TCP) or ws (WebSocket) is set.
type pendingConn struct {
	conn      net.Conn
	ws        *websocket.Conn // WebSocket peers — keep raw conn for message-preserving copy (#293)
	remote    string          // RemoteAddr string (WS upgrade remote)
	transport relayTransport
	created   time.Time
	done      chan struct{} // closed when paired or timed out
}

func (pc *pendingConn) close() {
	if pc.ws != nil {
		_ = pc.ws.Close(websocket.StatusNormalClosure, "")
		return
	}
	if pc.conn != nil {
		pc.conn.Close()
	}
}

func (pc *pendingConn) remoteAddr() string {
	if pc.remote != "" {
		return pc.remote
	}
	if pc.conn != nil {
		return pc.conn.RemoteAddr().String()
	}
	return "unknown"
}

// New creates a new relay server instance.
func New(cfg *config.Config) *Server {
	return &Server{
		cfg:            cfg,
		authorizations: defaultAuthorizationRegistry,
	}
}

// SetBandwidthLimiter sets the bandwidth limiter for relay sessions.
func (s *Server) SetBandwidthLimiter(bl *ratelimit.BandwidthLimiter) {
	s.bwLimiter = bl
}

// SetConnLimiter sets the per-IP connection limiter for relay abuse prevention.
func (s *Server) SetConnLimiter(cl *ratelimit.ConnLimiter) {
	s.connLimiter = cl
}

// SetSessionLimiter limits active (paired) relay sessions per IP.
func (s *Server) SetSessionLimiter(cl *ratelimit.ConnLimiter) {
	s.sessionLimiter = cl
}

// SetAuthorizationRegistry overrides the signal-issued relay authorization
// registry. It is primarily useful for isolated deployments and tests.
func (s *Server) SetAuthorizationRegistry(registry *AuthorizationRegistry) {
	if registry != nil {
		s.authorizations = registry
	}
}

// SetBillingCallbacks registers hooks when relay sessions start/end (commercialization).
func (s *Server) SetBillingCallbacks(onStart, onEnd func(uuid string)) {
	s.onRelayStart = onStart
	s.onRelayEnd = onEnd
}

// Start launches the relay TCP listener.
func (s *Server) Start(ctx context.Context) error {
	s.ctx, s.cancel = context.WithCancel(ctx)

	var err error
	s.tcpLn, err = net.Listen("tcp", fmt.Sprintf(":%d", s.cfg.RelayPort))
	if err != nil {
		return fmt.Errorf("relay: listen TCP :%d: %w", s.cfg.RelayPort, err)
	}

	// Phase 3: Wrap relay TCP listener with dual-mode TLS if enabled.
	// Dual-mode auto-detects TLS ClientHello (0x16) vs plain protobuf,
	// allowing both legacy and TLS clients on the same port.
	if s.cfg.RelayTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("relay: %w", err)
		}
		s.tcpLn = config.NewDualModeListener(s.tcpLn, tlsCfg)
		log.Printf("[relay] TCP+TLS (dual-mode) listening on :%d", s.cfg.RelayPort)
	} else {
		log.Printf("[relay] TCP listening on :%d", s.cfg.RelayPort)
	}

	s.wg.Add(3)
	go s.serveTCP()
	go s.serveWS()
	go s.cleanupPending()

	return nil
}

// Stop gracefully shuts down the relay server.
func (s *Server) Stop() {
	log.Printf("[relay] Shutting down...")
	s.cancel()
	if s.tcpLn != nil {
		s.tcpLn.Close()
	}
	if s.wsHTTP != nil {
		s.wsHTTP.Shutdown(context.Background())
	}
	s.wg.Wait()
	log.Printf("[relay] Stopped (total relayed: %d sessions)", s.TotalRelayed.Load())
}

// serveTCP accepts incoming relay connections.
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
				log.Printf("[relay] TCP accept error: %v", err)
				continue
			}
		}
		go s.handleConn(conn)
	}
}

// handleConn handles a single relay connection.
// Relay is a "dumb pipe" — no NaCl secure TCP on relay port.
// E2E encryption is between RustDesk clients at the application layer.
func (s *Server) handleConn(conn net.Conn) {
	// Per-IP connection limit
	if s.connLimiter != nil {
		ip, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
		if !s.connLimiter.Acquire(ip) {
			log.Printf("[relay] Connection rejected from %s (per-IP limit exceeded)", ip)
			conn.Close()
			return
		}
		defer s.connLimiter.Release(ip)
	}

	// Read the relay request directly — no KeyExchange for relay
	msg, err := codec.ReadRawProto(conn, config.RelayPairTimeout)
	if err != nil {
		log.Printf("[relay] ReadRawProto failed from %s: %v", conn.RemoteAddr(), err)
		conn.Close()
		return
	}

	rr := msg.GetRequestRelay()
	if rr == nil {
		// Not a relay request — could be a health check
		if hc := msg.GetHc(); hc != nil {
			resp := &pb.RendezvousMessage{
				Union: &pb.RendezvousMessage_Hc{
					Hc: &pb.HealthCheck{Token: hc.Token},
				},
			}
			if err := codec.WriteRawProto(conn, resp); err != nil {
				log.Printf("[relay] Health check response failed to %s: %v", conn.RemoteAddr(), err)
			}
		}
		conn.Close()
		return
	}

	uuid := rr.Uuid
	if uuid == "" {
		log.Printf("[relay] Empty UUID in RequestRelay from %s (rejecting)", conn.RemoteAddr())
		conn.Close()
		return
	}
	if s.authorizations == nil || !s.authorizations.Claim(uuid) {
		log.Printf("[relay] Unauthorized relay UUID from %s (rejecting)", conn.RemoteAddr())
		conn.Close()
		return
	}

	log.Printf("[relay] Connection from %s for UUID %s", conn.RemoteAddr(), uuid)
	s.pairIncomingConn(&pendingConn{
		conn:      conn,
		remote:    conn.RemoteAddr().String(),
		transport: relayTransportTCP,
		created:   timeNow(),
		done:      make(chan struct{}),
	}, uuid)
}

// pairIncomingConn pairs two relay connections sharing the same session UUID.
// LoadOrStore avoids a race where simultaneous connections both miss LoadAndDelete
// and overwrite each other in pending without ever pairing.
// Peers must use the same transport (TCP or WS); mixed framing is rejected (#290).
func (s *Server) pairIncomingConn(pc *pendingConn, uuid string) {
	if val, loaded := s.pending.LoadOrStore(uuid, pc); loaded {
		existing := val.(*pendingConn)
		s.pending.Delete(uuid)
		close(existing.done)
		if existing.transport != pc.transport {
			log.Printf("[relay] Protocol mismatch for UUID %s: %s <-> %s (rejecting mixed WebSocket/native relay)",
				uuid, existing.transport, pc.transport)
			existing.close()
			pc.close()
			return
		}
		if pc.transport == relayTransportWS {
			s.startWSRelay(existing.ws, pc.ws, existing.remoteAddr(), pc.remoteAddr(), uuid)
			return
		}
		s.startRelay(existing.conn, pc.conn, uuid)
		return
	}

	select {
	case <-pc.done:
		return
	case <-timeAfter(config.RelayPairTimeout):
		if val, ok := s.pending.Load(uuid); ok && val.(*pendingConn) == pc {
			s.pending.Delete(uuid)
			s.authorizations.Release(uuid)
			pc.close()
			log.Printf("[relay] Pair timeout for UUID %s", uuid)
		}
	case <-s.ctx.Done():
		if val, ok := s.pending.Load(uuid); ok && val.(*pendingConn) == pc {
			s.pending.Delete(uuid)
			s.authorizations.Release(uuid)
			pc.close()
		}
	}
}

// startRelay runs the bidirectional byte copy between two paired connections.
func (s *Server) startRelay(conn1, conn2 net.Conn, uuid string) {
	if s.sessionLimiter != nil {
		ips := make([]string, 0, 2)
		for _, c := range []net.Conn{conn1, conn2} {
			ip, _, err := net.SplitHostPort(c.RemoteAddr().String())
			if err != nil {
				ip = c.RemoteAddr().String()
			}
			if !s.sessionLimiter.Acquire(ip) {
				log.Printf("[relay] Active session limit exceeded for %s (UUID %s)", ip, uuid)
				conn1.Close()
				conn2.Close()
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

	log.Printf("[relay] Pair established: %s <-> %s (UUID: %s)",
		conn1.RemoteAddr(), conn2.RemoteAddr(), uuid)

	if s.onRelayStart != nil {
		s.onRelayStart(uuid)
	}

	// NOTE: Do NOT send RelayResponse confirmation to clients here.
	// The RustDesk client's create_relay() does not read any response from
	// the relay server after sending RequestRelay. The client's
	// secure_connection() immediately reads the first message expecting
	// Message::SignedId (message.proto) from the target peer. Injecting a
	// RendezvousMessage::RelayResponse (rendezvous.proto) here would be
	// parsed as the wrong proto type, breaking the E2E encryption handshake
	// and causing the connection to fall back to unencrypted mode.

	// M7: Set initial idle timeout deadlines. These are extended by the
	// idleTimeoutConn wrapper on every successful Read, so active sessions
	// stay alive while truly idle sessions get cleaned up.
	idleTimeout := config.RelayIdleTimeout
	conn1.SetDeadline(time.Now().Add(idleTimeout))
	conn2.SetDeadline(time.Now().Add(idleTimeout))

	// Wrap connections with idle-timeout extension
	ic1 := &idleTimeoutConn{Conn: conn1, timeout: idleTimeout}
	ic2 := &idleTimeoutConn{Conn: conn2, timeout: idleTimeout}

	// Set up readers/writers with optional bandwidth limiting
	var r1 io.Reader = ic1
	var r2 io.Reader = ic2
	var w1 io.Writer = ic1
	var w2 io.Writer = ic2

	if s.bwLimiter != nil {
		r1 = s.bwLimiter.WrapReader(ic1)
		r2 = s.bwLimiter.WrapReader(ic2)
		w1 = s.bwLimiter.WrapWriter(ic1)
		w2 = s.bwLimiter.WrapWriter(ic2)
	}

	done := make(chan struct{})
	var once sync.Once

	// Bidirectional copy — raw bytes, no protobuf parsing
	go func() {
		io.Copy(w1, r2)
		once.Do(func() { close(done) })
	}()

	go func() {
		io.Copy(w2, r1)
		once.Do(func() { close(done) })
	}()

	// Wait for one direction to finish, then clean up both
	<-done

	if s.onRelayEnd != nil {
		s.onRelayEnd(uuid)
	}

	conn1.Close()
	conn2.Close()

	if s.bwLimiter != nil {
		// Two WrapReader calls = two sessions tracked
		s.bwLimiter.SessionDone()
		s.bwLimiter.SessionDone()
	}

	s.ActiveSessions.Add(-1)
	log.Printf("[relay] Session ended: UUID %s (active: %d)", uuid, s.ActiveSessions.Load())
}

// idleTimeoutConn wraps a net.Conn and extends the deadline on every successful
// Read or Write. This ensures that active relay sessions stay alive while truly
// idle sessions (where both sides have gone silent) are closed after the timeout.
// M7: Prevents stale io.Copy goroutines from hanging forever.
type idleTimeoutConn struct {
	net.Conn
	timeout time.Duration
}

func (c *idleTimeoutConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.Conn.SetDeadline(time.Now().Add(c.timeout))
	}
	return n, err
}

func (c *idleTimeoutConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if n > 0 {
		c.Conn.SetDeadline(time.Now().Add(c.timeout))
	}
	return n, err
}

// cleanupPending periodically removes stale pending connections.
func (s *Server) cleanupPending() {
	defer s.wg.Done()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.pending.Range(func(key, value any) bool {
				pc := value.(*pendingConn)
				if time.Since(pc.created) > config.RelayPairTimeout {
					if _, loaded := s.pending.LoadAndDelete(key); loaded {
						s.authorizations.Release(key.(string))
						pc.close()
						close(pc.done)
					}
				}
				return true
			})
		}
	}
}
