package meshcentral

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/security"
)

// Gateway implements MeshCentral .ashx WebSocket endpoints on the API listener.
type Gateway struct {
	cfg       *config.Config
	db        db.Database
	peerMap   *peer.Map
	eventBus  *events.Bus
	auditLog  *audit.Logger
	blocklist *security.Blocklist
	jwt       *auth.JWTManager
	limiter   *ratelimit.IPLimiter
	cookies   *CookieCodec
	creds     *AgentCredentials
	assets    *CoreAssets
	webHash   []byte // SHA-384 of TLS web cert (48 bytes)

	agents    sync.Map // peerID -> *AgentConn
	relays    sync.Map // relayID -> *relaySession (non-KVM)
	relayHubs sync.Map // relayID -> *relayHub (KVM multiplex)
	relayMeta sync.Map // relayID -> *relayMeta

	ctx    context.Context
	cancel context.CancelFunc

	activeAgents atomic.Int64
	version      string
}

// NewGateway creates a MeshCentral compatibility gateway.
func NewGateway(cfg *config.Config, database db.Database, peerMap *peer.Map, eventBus *events.Bus, jwtSecret string) (*Gateway, error) {
	rate := cfg.MeshRateLimit
	if rate <= 0 {
		rate = 30
	}
	creds, err := LoadOrCreateAgentCredentials(cfg.MeshAgentCertFile)
	if err != nil {
		return nil, err
	}
	assets, err := LoadCoreAssets(cfg.MeshCoreVersion, cfg.MeshAssetsDir)
	if err != nil {
		return nil, err
	}
	cookieCodec, err := NewCookieCodec(jwtSecret)
	if err != nil {
		return nil, err
	}
	return &Gateway{
		cfg:      cfg,
		db:       database,
		peerMap:  peerMap,
		eventBus: eventBus,
		limiter:  ratelimit.NewIPLimiter(rate, 1*time.Minute, 5*time.Minute),
		cookies:  cookieCodec,
		creds:    creds,
		assets:   assets,
		version:  cfg.MeshCoreVersion,
	}, nil
}

// SetBlocklist attaches IP blocklist.
func (g *Gateway) SetBlocklist(bl *security.Blocklist) { g.blocklist = bl }

// SetAuditLogger attaches audit logger.
func (g *Gateway) SetAuditLogger(al *audit.Logger) { g.auditLog = al }

// SetJWTManager attaches JWT manager for control channel auth.
func (g *Gateway) SetJWTManager(jm *auth.JWTManager) { g.jwt = jm }

// SetVersion sets build version for logs.
func (g *Gateway) SetVersion(v string) { g.version = v }

// SetWebCertHash sets SHA-384 hash of the public TLS certificate (48 bytes).
func (g *Gateway) SetWebCertHash(hash []byte) {
	if len(hash) == sha384Size {
		g.webHash = append([]byte(nil), hash...)
	}
}

// ServerID returns hex ServerID for .msh files.
func (g *Gateway) ServerID() string { return g.creds.ServerID }

// ActiveAgentCount returns connected mesh agents.
func (g *Gateway) ActiveAgentCount() int64 { return g.activeAgents.Load() }

// AgentCertInfo returns mesh agent-server certificate path and presence on disk.
func (g *Gateway) AgentCertInfo() (path string, present bool, modified string) {
	path = g.cfg.MeshAgentCertFile
	if path == "" {
		path = "mesh_agent_server.pem"
	}
	info, err := os.Stat(path)
	if err != nil {
		return path, false, ""
	}
	return path, true, info.ModTime().Format(time.RFC3339)
}

// IsConnected reports whether peer ID has live mesh agent connection.
func (g *Gateway) IsConnected(peerID string) bool {
	if v, ok := g.agents.Load(peerID); ok {
		ac, _ := v.(*AgentConn)
		return ac != nil && ac.authenticated
	}
	return false
}

// MeshNodeID returns stored mesh node id for peer.
func (g *Gateway) MeshNodeID(peerID string) string {
	if v, ok := g.agents.Load(peerID); ok {
		ac, _ := v.(*AgentConn)
		if ac != nil {
			return ac.meshNodeID
		}
	}
	val, _ := g.db.GetConfig("mesh_node_id_" + peerID)
	return val
}

// Start initializes gateway lifecycle context.
func (g *Gateway) Start(ctx context.Context) error {
	g.ctx, g.cancel = context.WithCancel(ctx)
	log.Printf("[mesh] Compatibility layer enabled (core %s, ServerID %s…)", g.assets.Version, g.creds.ServerID[:16])
	return nil
}

// Stop drains agent connections.
func (g *Gateway) Stop() {
	if g.cancel != nil {
		g.cancel()
	}
	g.agents.Range(func(key, value any) bool {
		if ac, ok := value.(*AgentConn); ok {
			ac.close()
		}
		return true
	})
	log.Printf("[mesh] Gateway stopped")
}

// RegisterRoutes mounts .ashx handlers on the API mux.
func (g *Gateway) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/agent.ashx", g.handleAgentWS)
	mux.HandleFunc("/meshrelay.ashx", g.handleRelayWS)
	mux.HandleFunc("/control.ashx", g.handleControlWS)
	mux.HandleFunc("/bettercore.js", g.handleBetterCoreJS)
	mux.HandleFunc("/meshcore.js", g.handleBetterCoreJS) // legacy alias
}

func (g *Gateway) handleBetterCoreJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(g.assets.CoreModule)
}

func (g *Gateway) allowIP(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r, g.cfg)
	if g.blocklist != nil && g.blocklist.IsIPBlocked(ip) {
		http.Error(w, "blocked", http.StatusForbidden)
		return false
	}
	if g.limiter != nil && !g.limiter.Allow(ip) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return false
	}
	return true
}

func clientIP(r *http.Request, cfg *config.Config) string {
	ip := r.RemoteAddr
	if idx := lastIndexByte(ip, ':'); idx > 0 {
		ip = ip[:idx]
	}
	if cfg != nil && cfg.ShouldHonorForwardedHeaders(r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := indexByte(xff, ','); i > 0 {
				return trimSpace(xff[:i])
			}
			return trimSpace(xff)
		}
	}
	return ip
}

func lastIndexByte(s string, c byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
