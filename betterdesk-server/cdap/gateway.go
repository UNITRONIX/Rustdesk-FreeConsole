// Package cdap implements the Custom Device Automation Protocol (CDAP) gateway.
// CDAP enables non-RustDesk devices (SCADA, IoT, OS agents, custom hardware) to
// connect to BetterDesk via a WebSocket-based JSON protocol and appear as
// manageable devices in the admin panel alongside standard RustDesk peers.
package cdap

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/security"
	"github.com/unitronix/betterdesk-server/sessiongrant"
)

// Gateway is the CDAP WebSocket server.
type Gateway struct {
	cfg       *config.Config
	db        db.Database
	peerMap   *peer.Map
	eventBus  *events.Bus
	auditLog  *audit.Logger
	blocklist *security.Blocklist
	jwt       *auth.JWTManager
	limiter   *ratelimit.IPLimiter
	// sessionGrantSigner binds passive Support Agent sessions to the
	// authenticated CDAP operator and target device.
	sessionGrantSigner *sessiongrant.Signer

	httpSrv *http.Server
	ln      net.Listener

	// alertEngine evaluates manifest alert definitions on state changes.
	alertEngine *AlertEngine

	// delegations stores active auth delegations (admin → user grants).
	delegations *DelegationStore

	// devices holds all authenticated CDAP connections keyed by device ID.
	devices sync.Map // map[string]*DeviceConn

	// pendingCommands tracks commands sent to devices, keyed by command ID.
	pendingCommands sync.Map // map[string]*PendingCommand

	// terminalSessions tracks active terminal sessions, keyed by session ID.
	terminalSessions sync.Map // map[string]*TerminalSession

	// desktopSessions tracks active remote desktop sessions, keyed by session ID.
	desktopSessions sync.Map // map[string]*DesktopSession

	// videoSessions tracks active video stream sessions, keyed by session ID.
	videoSessions sync.Map // map[string]*VideoSession

	// fileSessions tracks active file browser sessions, keyed by session ID.
	fileSessions sync.Map // map[string]*FileSession

	// audioSessions tracks active audio stream sessions, keyed by session ID.
	audioSessions sync.Map // map[string]*AudioSession

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	totalConns  atomic.Int64
	activeConns atomic.Int64

	version string
}

// PendingCommand tracks a command sent to a device, awaiting ACK/NACK.
type PendingCommand struct {
	CommandID string
	DeviceID  string
	SentAt    time.Time
	ResultCh  chan *CommandResponsePayload // optional; nil if fire-and-forget
}

// New creates a new CDAP gateway.
func New(cfg *config.Config, database db.Database, peerMap *peer.Map, eventBus *events.Bus) *Gateway {
	rateLimit := cfg.CDAPRateLimit
	if rateLimit <= 0 {
		rateLimit = 30
	}
	return &Gateway{
		cfg:         cfg,
		db:          database,
		peerMap:     peerMap,
		eventBus:    eventBus,
		limiter:     ratelimit.NewIPLimiter(rateLimit, 1*time.Minute, 5*time.Minute),
		alertEngine: NewAlertEngine(eventBus),
		delegations: NewDelegationStore(),
	}
}

// SetBlocklist sets the blocklist.
func (g *Gateway) SetBlocklist(bl *security.Blocklist) { g.blocklist = bl }

// SetAuditLogger sets the audit logger.
func (g *Gateway) SetAuditLogger(al *audit.Logger) { g.auditLog = al }

// SetJWTManager sets the JWT manager.
func (g *Gateway) SetJWTManager(jm *auth.JWTManager) { g.jwt = jm }

// SetSessionGrantPrivateKey enables signed passive-session grants for Support
// Agent devices. It must receive the server identity key whose public half is
// embedded in their signed branding profile.
func (g *Gateway) SetSessionGrantPrivateKey(key ed25519.PrivateKey) error {
	signer, err := sessiongrant.NewSigner(key)
	if err != nil {
		return err
	}
	g.sessionGrantSigner = signer
	return nil
}

// SetRateLimiter overrides the default rate limiter.
func (g *Gateway) SetRateLimiter(l *ratelimit.IPLimiter) { g.limiter = l }

// SetVersion sets the version string for startup log.
func (g *Gateway) SetVersion(v string) { g.version = v }

// Delegations returns the delegation store for auth delegation management.
func (g *Gateway) Delegations() *DelegationStore { return g.delegations }

// Start binds the WebSocket listener and begins accepting connections.
func (g *Gateway) Start(ctx context.Context) error {
	g.ctx, g.cancel = context.WithCancel(ctx)

	addr := fmt.Sprintf(":%d", g.cfg.CDAPPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("cdap: listen %s: %w", addr, err)
	}

	// Wrap with TLS auto-detect if enabled
	if g.cfg.CDAPTLSEnabled() {
		tlsCfg, tlsErr := config.LoadTLSConfig(g.cfg.TLSCertFile, g.cfg.TLSKeyFile)
		if tlsErr != nil {
			ln.Close()
			return fmt.Errorf("cdap: tls config: %w", tlsErr)
		}
		if g.cfg.CDAPTLSRequiredEnabled() {
			ln = config.NewTLSOnlyListener(ln, tlsCfg)
			log.Printf("[cdap] TLS enabled (plaintext rejected)")
		} else {
			ln = config.NewDualModeListener(ln, tlsCfg)
			log.Printf("[cdap] TLS enabled (dual-mode: plain + TLS auto-detect)")
		}
	}

	g.ln = ln

	mux := http.NewServeMux()
	mux.HandleFunc("/cdap", g.handleWebSocket)
	mux.HandleFunc("/cdap/health", g.handleHealth)

	g.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := g.httpSrv.Serve(g.ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[cdap] Server error: %v", err)
		}
	}()

	// Heartbeat monitor: detect stale CDAP connections
	g.wg.Add(1)
	go g.heartbeatMonitor()

	// Delegation cleanup: purge expired delegations every 5 minutes
	g.wg.Add(1)
	go g.delegationCleaner()

	scheme := "ws"
	if g.cfg.CDAPTLSEnabled() {
		scheme = "wss"
	}
	log.Printf("[cdap] Gateway started on %s://0.0.0.0:%d/cdap", scheme, g.cfg.CDAPPort)
	return nil
}

// Stop gracefully shuts down the gateway.
func (g *Gateway) Stop() {
	log.Printf("[cdap] Shutting down gateway...")
	g.cancel()

	// Close all device connections
	g.devices.Range(func(key, value any) bool {
		if dc, ok := value.(*DeviceConn); ok {
			dc.Close(websocket.StatusGoingAway, "server shutdown")
		}
		return true
	})

	// Graceful HTTP shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if g.httpSrv != nil {
		g.httpSrv.Shutdown(shutdownCtx)
	}

	g.wg.Wait()
	log.Printf("[cdap] Gateway stopped (total connections served: %d)", g.totalConns.Load())
}

// ActiveConnections returns the current number of active CDAP connections.
func (g *Gateway) ActiveConnections() int64 {
	return g.activeConns.Load()
}

// handleHealth serves the /cdap/health endpoint for monitoring.
func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":      "ok",
		"connections": g.activeConns.Load(),
		"total":       g.totalConns.Load(),
		"version":     g.version,
	})
}

// handleWebSocket upgrades the HTTP connection to WebSocket and runs the
// CDAP protocol state machine.
func (g *Gateway) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Extract client IP for rate limiting and logging
	clientIP := extractIP(r)

	// Rate limit
	if g.limiter != nil && !g.limiter.Allow(clientIP) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	// Blocklist check
	if g.blocklist != nil {
		if g.blocklist.IsIPBlocked(clientIP) {
			http.Error(w, "blocked", http.StatusForbidden)
			return
		}
	}

	acceptOpts := &websocket.AcceptOptions{
		Subprotocols: []string{"cdap-v1"},
	}
	if g.cfg != nil {
		// With no configured patterns, coder/websocket enforces its safe
		// same-host default for browser origins. Native CDAP agents omit Origin
		// and remain compatible; configured patterns allow trusted dashboards.
		acceptOpts.OriginPatterns = g.cfg.GetAllowedWSOrigins()
	}
	conn, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		log.Printf("[cdap] WebSocket upgrade failed from %s: %v", clientIP, err)
		return
	}
	// Default coder/websocket limit is 32 KiB which is far too small for
	// continuous desktop frames (a 1280x720 q70 JPEG base64-encoded is
	// ~150 KB). Allow up to 8 MB per CDAP message to support screen capture
	// and bulk file payloads.
	conn.SetReadLimit(8 * 1024 * 1024)

	g.totalConns.Add(1)
	g.activeConns.Add(1)
	defer g.activeConns.Add(-1)

	// Run the connection state machine
	g.runConnection(r.Context(), conn, clientIP)
}

// runConnection drives the CDAP protocol:
//
//	→ auth → auth_result
//	→ register (with manifest) → registered
//	→ heartbeat / state_update / command_response / ...
func (g *Gateway) runConnection(baseCtx context.Context, conn *websocket.Conn, clientIP string) {
	// Create a context bound to both the HTTP request and our gateway's lifecycle
	ctx, cancel := context.WithCancel(baseCtx)
	defer cancel()
	go func() {
		select {
		case <-g.ctx.Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	// Phase 1: Authentication (30-second deadline)
	authCtx, authCancel := context.WithTimeout(ctx, 30*time.Second)
	dc, authErr := g.handleAuth(authCtx, conn, clientIP)
	authCancel()
	if authErr != nil {
		sendError(ctx, conn, 1001, authErr.Error())
		conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return
	}
	defer func() {
		g.removeDevice(dc)
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	// Phase 2: Registration (30-second deadline)
	regCtx, regCancel := context.WithTimeout(ctx, 30*time.Second)
	regErr := g.handleRegister(regCtx, dc)
	regCancel()
	if regErr != nil {
		sendError(ctx, conn, 2001, regErr.Error())
		return
	}

	// Phase 3: Main message loop
	g.messageLoop(ctx, dc)
}

// messageLoop reads messages until the connection closes or context is cancelled.
func (g *Gateway) messageLoop(ctx context.Context, dc *DeviceConn) {
	for {
		typ, raw, msg, err := dc.ReadAny(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("[cdap] %s: read error: %v", dc.ID, err)
			}
			return
		}

		// Binary fast-path: raw bytes (currently used for desktop JPEG frames).
		// The agent prefixes the payload with FRAME_HEADER_SIZE bytes encoding
		// the desktop session ID, so we can route the frame to the correct
		// browser without parsing JSON.
		if typ == websocket.MessageBinary {
			g.handleDesktopFrameBinary(ctx, dc, raw)
			continue
		}

		if msg == nil {
			continue
		}

		switch msg.Type {
		case "heartbeat":
			g.handleHeartbeat(ctx, dc, msg)
		case "state_update":
			g.handleStateUpdate(ctx, dc, msg)
		case "bulk_update":
			g.handleBulkUpdate(ctx, dc, msg)
		case "command_response":
			g.handleCommandResponse(ctx, dc, msg)
		case "event":
			g.handleEvent(ctx, dc, msg)
		case "log":
			g.handleLog(ctx, dc, msg)
		case "help_request":
			g.handleHelpRequest(ctx, dc, msg)
		case "chat_message":
			g.handleChatMessage(ctx, dc, msg)
		case "unregister":
			g.handleUnregister(ctx, dc, msg)
			return
		case "token_refresh":
			g.handleTokenRefresh(ctx, dc, msg)
		case "terminal_output":
			g.handleTerminalOutput(ctx, dc, msg)
		case "terminal_end":
			g.handleTerminalEnd(ctx, dc, msg)
		case "desktop_frame":
			g.handleDesktopFrame(ctx, dc, msg)
		case "desktop_meta":
			g.HandleDesktopMeta(ctx, dc.ID, msg.Payload)
		case "desktop_end":
			g.handleDesktopEnd(ctx, dc, msg)
		case "desktop_consent_denied":
			g.handleDesktopConsentDenied(ctx, dc, msg)
		case "desktop_input_error":
			g.HandleDesktopInputError(ctx, dc, msg)
		case "video_frame":
			g.handleVideoFrame(ctx, dc, msg)
		case "video_end":
			g.handleVideoEnd(ctx, dc, msg)
		case "file_list_response", "file_read_response", "file_write_response", "file_delete_response":
			g.handleFileResponse(ctx, dc, msg)
		case "file_end":
			g.handleFileEnd(ctx, dc, msg)
		case "audio_frame":
			g.handleAudioFrame(ctx, dc, msg)
		case "audio_end":
			g.handleAudioEnd(ctx, dc, msg)
		case "clipboard_update":
			g.HandleClipboardUpdate(dc.ID, msg.Payload)
		case "key_exchange":
			g.HandleKeyExchange(ctx, dc.ID, msg.Payload)
		case "cursor_update":
			g.HandleCursorUpdate(ctx, dc.ID, msg.Payload)
		case "codec_answer":
			g.HandleCodecAnswer(ctx, dc.ID, msg.Payload)
		case "monitor_list":
			g.HandleMonitorList(ctx, dc.ID, msg.Payload)
		default:
			sendError(ctx, dc.conn, 1006, fmt.Sprintf("unknown message type: %s", msg.Type))
		}
	}
}

// heartbeatMonitor periodically checks for stale CDAP connections
// and cleans up expired pending commands.
func (g *Gateway) heartbeatMonitor() {
	defer g.wg.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-g.ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			g.devices.Range(func(key, value any) bool {
				dc, ok := value.(*DeviceConn)
				if !ok {
					return true
				}
				// 3x heartbeat interval = stale
				maxIdle := time.Duration(dc.HeartbeatInterval) * time.Second * 3
				if maxIdle < 60*time.Second {
					maxIdle = 60 * time.Second
				}
				if now.Sub(dc.LastHeartbeat) > maxIdle {
					log.Printf("[cdap] %s: heartbeat timeout (last: %s ago)", dc.ID, now.Sub(dc.LastHeartbeat).Round(time.Second))
					dc.Close(websocket.StatusPolicyViolation, "heartbeat timeout")
					g.removeDevice(dc)
				}
				return true
			})

			// Cleanup stale pending commands (>2 min without response)
			g.pendingCommands.Range(func(key, value any) bool {
				pc, ok := value.(*PendingCommand)
				if !ok {
					return true
				}
				if now.Sub(pc.SentAt) > 2*time.Minute {
					if pc.ResultCh != nil {
						close(pc.ResultCh)
					}
					g.pendingCommands.Delete(key)
				}
				return true
			})
		}
	}
}

// delegationCleaner periodically purges expired auth delegations.
func (g *Gateway) delegationCleaner() {
	defer g.wg.Done()
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-g.ctx.Done():
			return
		case <-ticker.C:
			if n := g.delegations.CleanExpired(); n > 0 {
				log.Printf("[cdap] Cleaned %d expired delegation(s)", n)
			}
		}
	}
}

// removeDevice cleans up a device connection from the registry.
func (g *Gateway) removeDevice(dc *DeviceConn) {
	if dc == nil || dc.ID == "" {
		return
	}
	g.devices.Delete(dc.ID)

	// Clear any firing alerts for this device
	if g.alertEngine != nil {
		g.alertEngine.RemoveDevice(dc.ID)
	}

	// Clean up manifest from server_config
	if err := g.db.DeleteConfig(fmt.Sprintf("cdap_manifest_%s", dc.ID)); err != nil {
		log.Printf("[cdap] %s: failed to delete manifest: %v", dc.ID, err)
	}

	// Clean up pending commands for this device
	g.pendingCommands.Range(func(key, value any) bool {
		if pc, ok := value.(*PendingCommand); ok && pc.DeviceID == dc.ID {
			if pc.ResultCh != nil {
				close(pc.ResultCh)
			}
			g.pendingCommands.Delete(key)
		}
		return true
	})

	g.cleanupDeviceSessions(dc.ID, "device disconnected")

	// Update peer status to OFFLINE
	if err := g.db.UpdatePeerStatus(dc.ID, "OFFLINE", dc.ClientIP); err != nil {
		log.Printf("[cdap] %s: failed to set offline: %v", dc.ID, err)
	}

	// Publish disconnect event
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "cdap_disconnect",
			Data: map[string]string{
				"peer_id": dc.ID,
				"reason":  "disconnected",
			},
		})
	}

	log.Printf("[cdap] %s: disconnected (session: %s)", dc.ID, time.Since(dc.ConnectedAt).Round(time.Second))
}

// SendCommand sends a command to a connected CDAP device and tracks it
// for ACK/NACK. Returns error if the device is not connected.
func (g *Gateway) SendCommand(ctx context.Context, deviceID string, cmd *CommandMessage) error {
	val, ok := g.devices.Load(deviceID)
	if !ok {
		return fmt.Errorf("device %s not connected", deviceID)
	}
	dc := val.(*DeviceConn)

	// Track pending command
	g.pendingCommands.Store(cmd.ID, &PendingCommand{
		CommandID: cmd.ID,
		DeviceID:  deviceID,
		SentAt:    time.Now(),
	})

	dc.CommandCount.Add(1)
	return dc.WriteMessage(ctx, &Message{
		Type:      "command",
		ID:        cmd.ID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   cmd.Payload,
	})
}

// SendChatToDevice delivers an operator chat message to a connected device.
// Returns an error if the device is not connected. The caller is responsible
// for persisting the message and performing RBAC checks.
func (g *Gateway) SendChatToDevice(ctx context.Context, deviceID, fromID, fromName, text string) error {
	val, ok := g.devices.Load(deviceID)
	if !ok {
		return fmt.Errorf("device %s not connected", deviceID)
	}
	dc := val.(*DeviceConn)

	payload, err := json.Marshal(map[string]string{
		"from_id":   fromID,
		"from_name": fromName,
		"text":      text,
	})
	if err != nil {
		return fmt.Errorf("marshal chat payload: %w", err)
	}

	return dc.WriteMessage(ctx, &Message{
		Type:      "chat_message",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payload,
	})
}

// ResolvePendingCommand resolves a pending command by ID.
// Returns the PendingCommand and true if found, nil and false otherwise.
func (g *Gateway) ResolvePendingCommand(commandID string) (*PendingCommand, bool) {
	val, ok := g.pendingCommands.LoadAndDelete(commandID)
	if !ok {
		return nil, false
	}
	return val.(*PendingCommand), true
}

// SendRevoke sends a revocation message to a connected CDAP device
// and forcefully closes its connection.
func (g *Gateway) SendRevoke(ctx context.Context, deviceID, reason string) error {
	val, ok := g.devices.Load(deviceID)
	if !ok {
		return fmt.Errorf("device %s not connected", deviceID)
	}
	dc := val.(*DeviceConn)

	// Send revoke message (best-effort)
	revokeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sendMessage(revokeCtx, dc.conn, "revoke", map[string]string{
		"reason": reason,
	})

	// Close the connection
	dc.Close(4003, reason)
	g.removeDevice(dc)

	g.auditAction("cdap_revoke", deviceID, map[string]string{
		"reason": reason,
	})

	log.Printf("[cdap] %s: revoked (%s)", deviceID, reason)
	return nil
}

// GetDeviceConn returns the connection for a device, or nil if not connected.
func (g *Gateway) GetDeviceConn(deviceID string) *DeviceConn {
	val, ok := g.devices.Load(deviceID)
	if !ok {
		return nil
	}
	return val.(*DeviceConn)
}

// extractIP extracts the client IP from the request, respecting X-Forwarded-For
// only when trust-proxy is configured (handled upstream in the HTTP handler).
func extractIP(r *http.Request) string {
	// Try X-Real-IP first (set by nginx)
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	// Try X-Forwarded-For
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	// Fall back to remote addr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
