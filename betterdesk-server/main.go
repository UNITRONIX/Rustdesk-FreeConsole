// BetterDesk Server — Clean-room RustDesk-compatible signal + relay server
// Single binary replacing both hbbs and hbbr
package main

import (
	"context"
	cryptoRand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	osSignal "os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/unitronix/betterdesk-server/admin"
	"github.com/unitronix/betterdesk-server/api"
	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/billing"
	"github.com/unitronix/betterdesk-server/cdap"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/internal/productversion"
	"github.com/unitronix/betterdesk-server/logging"
	"github.com/unitronix/betterdesk-server/meshcentral"
	"github.com/unitronix/betterdesk-server/metrics"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/relay"
	"github.com/unitronix/betterdesk-server/reload"
	"github.com/unitronix/betterdesk-server/security"
	sigServer "github.com/unitronix/betterdesk-server/signal"
	"github.com/unitronix/betterdesk-server/timesync"
)

var (
	Version   = "dev"
	BuildDate = "unknown"

	runSQLiteAuthConsolidation       bool
	sqliteAuthConsolidationDryRun    bool
	sqliteAuthConsolidationBackupDir string
	sqliteAuthConsolidationRollback  string
)

func init() {
	if Version == "dev" {
		if v := productversion.Product(); v != "" && v != "dev" {
			Version = v
		}
	}
}

func main() {
	cfg := parseFlags()

	// Configure log format (must be before any log output)
	logCleanup := logging.Setup(cfg.LogFormat, cfg.LogLevel)
	defer logCleanup()

	if sqliteAuthConsolidationRollback != "" {
		if err := db.RollbackSQLiteAuth(cfg.DBPath, sqliteAuthConsolidationRollback); err != nil {
			log.Fatalf("SQLite auth consolidation rollback failed: %v", err)
		}
		log.Printf("SQLite auth consolidation rollback completed")
		return
	}
	if runSQLiteAuthConsolidation {
		report, err := db.ConsolidateSQLiteAuth(db.SQLiteAuthConsolidationOptions{
			DBPath:     cfg.DBPath,
			AuthDBPath: cfg.AuthDBPath,
			BackupDir:  sqliteAuthConsolidationBackupDir,
			DryRun:     sqliteAuthConsolidationDryRun,
		})
		if err != nil {
			log.Fatalf("SQLite auth consolidation failed: %v", err)
		}
		encoded, err := json.Marshal(report)
		if err != nil {
			log.Fatalf("Encode SQLite auth consolidation report: %v", err)
		}
		fmt.Println(string(encoded))
		return
	}

	log.Printf("========================================")
	log.Printf("  BetterDesk Server %s", Version)
	log.Printf("  Build: %s", BuildDate)
	log.Printf("========================================")
	log.Printf("  Mode:       %s", cfg.Mode)
	log.Printf("  Signal:     :%d (UDP+TCP)", cfg.SignalPort)
	log.Printf("  NAT Test:   :%d (TCP)", cfg.SignalPort-1)
	log.Printf("  WS Signal:  :%d (WebSocket)", cfg.SignalPort+2)
	log.Printf("  Relay:      :%d (TCP)", cfg.RelayPort)
	log.Printf("  WS Relay:   :%d (WebSocket)", cfg.RelayPort+2)
	if cfg.APITLSEnabled() {
		log.Printf("  API:        :%d (HTTPS)", cfg.APIPort)
	} else {
		log.Printf("  API:        :%d (HTTP)", cfg.APIPort)
	}
	log.Printf("  Database:   %s", cfg.DBPath)
	if cfg.SignalTLSEnabled() {
		log.Printf("  TLS Signal: ENABLED (dual-mode: plain+TLS)")
	}
	if cfg.RelayTLSEnabled() {
		log.Printf("  TLS Relay:  ENABLED (dual-mode: plain+TLS)")
	}
	if cfg.APITLSEnabled() {
		log.Printf("  TLS API:    ENABLED")
		log.Printf("  ⚠ WARNING:  TLS on API port breaks Node.js console (HTTP) and RustDesk client connections!")
		log.Printf("              Only enable --tls-api if ALL consumers use HTTPS. See issue #104.")
		log.Printf("              To fix: remove TLS_API=Y from env or -tls-api from flags.")
	}
	if cfg.HasTLSCert() {
		log.Printf("  TLS Cert:   %s", cfg.TLSCertFile)
		// Validate cert files actually exist — a missing file silently disables TLS
		// without any error, which is a common misconfiguration (e.g. typo in path).
		if _, err := os.Stat(cfg.TLSCertFile); os.IsNotExist(err) {
			log.Printf("  ⚠ WARNING:  TLS certificate file NOT FOUND: %s", cfg.TLSCertFile)
			log.Printf("              TLS_SIGNAL and TLS_RELAY will be silently disabled.")
			log.Printf("              Check TLS_CERT env var or --tls-cert flag for typos.")
		}
		if _, err := os.Stat(cfg.TLSKeyFile); os.IsNotExist(err) {
			log.Printf("  ⚠ WARNING:  TLS key file NOT FOUND: %s", cfg.TLSKeyFile)
			log.Printf("              TLS_SIGNAL and TLS_RELAY will be silently disabled.")
			log.Printf("              Check TLS_KEY env var or --tls-key flag for typos.")
		}
	} else if cfg.TLSSignal || cfg.TLSRelay {
		// User set TLS_SIGNAL=Y or TLS_RELAY=Y but forgot to set cert/key paths
		log.Printf("  ⚠ WARNING:  TLS_SIGNAL=%v TLS_RELAY=%v but TLS_CERT/TLS_KEY are not set.", cfg.TLSSignal, cfg.TLSRelay)
		log.Printf("              Signal and relay will run without TLS. Set TLS_CERT and TLS_KEY env vars.")
	}
	log.Printf("========================================")

	// Load or generate Ed25519 keypair
	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		log.Fatalf("Failed to initialize keypair: %v", err)
	}
	log.Printf("Server public key: %s", kp.PublicKeyBase64())

	// Initialize database
	database, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer database.Close()

	if err := database.Migrate(); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	// Defensive: ensure client_sessions exists even if an older binary skipped #242 DDL (#284).
	if err := database.EnsureClientSessionsSchema(); err != nil {
		log.Fatalf("Failed to ensure client_sessions schema: %v", err)
	}

	// Load API key from .api_key file or API_KEY env var and sync to database.
	// This ensures the Node.js console and Go server share the same API key
	// even when the server is started without the ALL-IN-ONE install script.
	loadAPIKey(cfg, database)

	// Reset all peers to offline on startup (clean slate)
	if err := database.SetAllOffline(); err != nil {
		log.Printf("WARN: Failed to reset peers to offline: %v", err)
	}

	log.Printf("Database initialized successfully")

	// Restore enrollment mode from DB (persisted via handleSetEnrollmentMode)
	if storedMode, _ := database.GetConfig("enrollment_mode"); storedMode != "" {
		cfg.EnrollmentMode = storedMode
		log.Printf("Restored enrollment mode from DB: %s", storedMode)
	}
	if cfg.EnrollmentMode != "" && cfg.EnrollmentMode != "open" {
		log.Printf("Enrollment restriction active: mode=%s (new devices need token/approval)", cfg.EnrollmentMode)
	}

	// Initialize security modules
	blocklist := security.NewBlocklist()
	if cfg.BlocklistFile != "" {
		if err := blocklist.LoadFromFile(cfg.BlocklistFile); err != nil {
			log.Printf("WARN: Failed to load blocklist from %s: %v", cfg.BlocklistFile, err)
		}
	}

	ipLimiter := ratelimit.NewIPLimiter(
		cfg.SignalRateLimitPerIP,
		config.IPRateLimitWindow,
		config.IPRateLimitCleanup,
	)
	defer ipLimiter.Stop()

	bwLimiter := ratelimit.NewBandwidthLimiter(
		config.DefaultTotalBandwidth,
		config.DefaultSingleBandwidth,
	)

	rateLimitDesc := fmt.Sprintf("%d/min", cfg.SignalRateLimitPerIP)
	if cfg.SignalRateLimitPerIP <= 0 {
		rateLimitDesc = "disabled"
	}
	log.Printf("Security modules initialized (blocklist=%d entries, rate-limit=%s)",
		blocklist.Count(), rateLimitDesc)

	// Initialize JWT manager for API authentication
	jwtSecret := cfg.JWTSecret
	if jwtSecret == "" {
		// Use a persistent secret from the database so tokens survive restarts
		stored, _ := database.GetConfig("jwt_secret")
		if stored != "" {
			jwtSecret = stored
		} else {
			generated, err := auth.GenerateRandomString(32)
			if err != nil {
				log.Fatalf("Failed to generate JWT secret: %v", err)
			}
			jwtSecret = generated
			_ = database.SetConfig("jwt_secret", jwtSecret)
			log.Printf("Generated and stored new JWT secret")
		}
	}
	jwtExpiry := cfg.JWTExpiry
	if jwtExpiry <= 0 {
		jwtExpiry = 24
	}
	jwtManager := auth.NewJWTManager(jwtSecret, time.Duration(jwtExpiry)*time.Hour)

	// Create initial admin user if no users exist
	userCount, _ := database.UserCount()
	if userCount == 0 {
		adminUser := cfg.InitAdminUser
		if adminUser == "" {
			adminUser = "admin"
		}
		adminPass := cfg.InitAdminPass
		if adminPass == "" {
			adminPass, _ = auth.GenerateRandomString(16)
		}
		hash, err := auth.HashPassword(adminPass)
		if err != nil {
			log.Fatalf("Failed to hash initial admin password: %v", err)
		}
		err = database.CreateUser(&db.User{
			Username:     adminUser,
			PasswordHash: hash,
			Role:         auth.RoleAdmin,
		})
		if err != nil {
			log.Fatalf("Failed to create initial admin user: %v", err)
		}
		log.Printf("========================================")
		log.Printf("  INITIAL ADMIN CREDENTIALS")
		log.Printf("  Username: %s", adminUser)
		if cfg.InitAdminPass == "" {
			dbDir := filepath.Dir(cfg.DBPath)
			credsFile, err := writeBootstrapAdminCredentials(dbDir, adminUser, adminPass)
			if err != nil {
				log.Fatalf("Failed to write credentials file: %v", err)
			}
			log.Printf("  Password: written to %s (mode 0600)", credsFile)
		} else {
			log.Printf("  Password: *** (user-provided, not logged)")
		}
		adminPass = ""
		log.Printf("  (change this password immediately!)")
		log.Printf("========================================")
	}

	// Initialize per-IP relay connection limiter
	var connLimiter *ratelimit.ConnLimiter
	if cfg.RelayMaxConnsIP > 0 {
		connLimiter = ratelimit.NewConnLimiterFromInt(cfg.RelayMaxConnsIP)
		log.Printf("Relay per-IP connection limit: %d", cfg.RelayMaxConnsIP)
	}
	var sessionLimiter *ratelimit.ConnLimiter
	if cfg.RelayMaxConnsIP > 0 {
		sessionLimiter = ratelimit.NewConnLimiterFromInt(cfg.RelayMaxConnsIP)
		log.Printf("Relay active-session per-IP limit: %d", cfg.RelayMaxConnsIP)
	}

	if cfg.EnrollmentMode == config.EnrollmentModeOpen {
		if !cfg.SignalTLSEnabled() || !cfg.RelayTLSEnabled() {
			log.Printf("  ⛔ ERROR [SECURITY]: ENROLLMENT_MODE=open without TLS_SIGNAL and TLS_RELAY — unsafe for Internet-facing production")
		}
	}

	// Initialize audit logger
	auditLogger := audit.NewLogger(cfg.AuditLogFile)
	defer auditLogger.Close()
	auditLogger.Log(audit.ActionServerStart, "system", "", map[string]string{
		"version": Version, "mode": cfg.Mode,
	})
	if cfg.AuditLogFile != "" {
		log.Printf("Audit logging to %s", cfg.AuditLogFile)
	}

	// Initialize metrics collector
	mc := metrics.NewCollector()
	log.Printf("Prometheus metrics available at /metrics")

	// Initialize config reload handler (SIGHUP on Unix, admin command on Windows)
	reloadHandler := reload.NewHandler()
	if cfg.BlocklistFile != "" {
		reloadHandler.OnReload(func() error {
			log.Printf("[reload] Reloading blocklist from %s", cfg.BlocklistFile)
			return blocklist.LoadFromFile(cfg.BlocklistFile)
		})
	}
	reloadHandler.OnReload(func() error {
		log.Printf("[reload] Reloading configuration from environment")
		cfg.LoadEnv()
		return nil
	})

	// Initialize admin TCP interface
	adminSrv := admin.New(cfg, database, nil, Version) // peer map set per mode
	adminSrv.SetBlocklist(blocklist)
	adminSrv.SetReloadFunc(reloadHandler.Execute)

	// Context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Time sync + billing (commercialization module)
	timeSyncSvc := timesync.NewService(database, timesync.Config{
		Servers:      cfg.GetNTPServers(),
		Interval:     60 * time.Second,
		QueryTimeout: 5 * time.Second,
		MaxSkew:      time.Duration(cfg.BillingMaxClockSkewMS) * time.Millisecond,
		RequireSync:  cfg.BillingRequireSyncedClock,
		TrustOSNTP:   cfg.BillingTrustOSNTP,
	})
	log.Printf("[timesync] NTP servers: %v (trust OS NTP when queries fail: %v)",
		cfg.GetNTPServers(), cfg.BillingTrustOSNTP)
	timeSyncSvc.Start(ctx)
	defer timeSyncSvc.Stop()

	reloadHandler.OnReload(func() error {
		timeSyncSvc.ApplyConfig(timesync.Config{
			Servers:     cfg.GetNTPServers(),
			MaxSkew:     time.Duration(cfg.BillingMaxClockSkewMS) * time.Millisecond,
			RequireSync: cfg.BillingRequireSyncedClock,
			TrustOSNTP:  cfg.BillingTrustOSNTP,
		})
		return nil
	})

	billingSvc := billing.NewService(database, timeSyncSvc, cfg.BillingRoundingMinutes, cfg.BillingRequireWorkReport)
	billingSvc.Start(ctx)

	// Start SIGHUP listener in background
	reloadDone := make(chan struct{})
	go reloadHandler.ListenSIGHUP(reloadDone)
	defer close(reloadDone)

	// BD-2026-010: Warn when WebSocket origin policy is permissive
	if cfg.AllowedWSOrigins == "" {
		log.Printf("[SECURITY] NOTICE: WS_ALLOWED_ORIGINS is not set — signal/relay WebSocket accepts all origins")
	}
	if cfg.APIAllowedWSOrigins == "" {
		log.Printf("[SECURITY] NOTICE: API_WS_ALLOWED_ORIGINS is not set — API events WebSocket accepts all origins")
	}

	// Start servers based on mode
	switch cfg.Mode {
	case "all":
		log.Printf("Starting signal + relay + API servers...")
		sig := sigServer.New(cfg, kp, database)
		sig.SetBlocklist(blocklist)
		sig.SetRateLimiter(ipLimiter)
		sig.SetAuditLogger(auditLogger)
		sig.SetBillingService(billingSvc)
		if err := sig.Start(ctx); err != nil {
			log.Fatalf("Failed to start signal server: %v", err)
		}
		defer sig.Stop()

		relaySrv := relay.New(cfg)
		relaySrv.SetBandwidthLimiter(bwLimiter)
		if connLimiter != nil {
			relaySrv.SetConnLimiter(connLimiter)
		}
		if sessionLimiter != nil {
			relaySrv.SetSessionLimiter(sessionLimiter)
		}
		relaySrv.SetBillingCallbacks(billingSvc.ActivateRelay, billingSvc.EndRelay)
		if err := relaySrv.Start(ctx); err != nil {
			log.Fatalf("Failed to start relay server: %v", err)
		}
		defer relaySrv.Stop()

		apiSrv := api.New(cfg, database, sig.PeerMap(), relaySrv, Version)
		defer attachPanelSync(apiSrv, billingSvc, database, cfg.DBPath, cfg.AuthDBPath)()
		apiSrv.SetBlocklist(blocklist)
		apiSrv.SetBandwidthLimiter(bwLimiter)
		apiSrv.SetAuditLogger(auditLogger)
		apiSrv.SetEventBus(sig.EventBus())
		apiSrv.SetMetrics(mc)
		apiSrv.SetJWTManager(jwtManager)
		apiSrv.SetKeyPair(kp)
		apiSrv.SetTimeSyncService(timeSyncSvc)
		apiSrv.SetBillingService(billingSvc)

		// LDAP provider (loads config from DB, hot-reloadable via API)
		apiSrv.InitLDAP()
		// OIDC/OAuth2 provider (loads config from DB, hot-reloadable via API)
		apiSrv.InitOIDC()

		// CDAP Gateway (optional — custom device automation protocol)
		var cdapGw *cdap.Gateway
		if cfg.CDAPEnabled {
			cdapGw = cdap.New(cfg, database, sig.PeerMap(), sig.EventBus())
			cdapGw.SetBlocklist(blocklist)
			cdapGw.SetAuditLogger(auditLogger)
			cdapGw.SetJWTManager(jwtManager)
			if err := cdapGw.SetSessionGrantPrivateKey(kp.PrivateKey); err != nil {
				log.Fatalf("Failed to configure CDAP session grant signer: %v", err)
			}
			cdapGw.SetVersion(Version)
			apiSrv.SetCDAPGateway(cdapGw)
		}

		// MeshCentral compatibility layer (optional)
		var meshGw *meshcentral.Gateway
		if cfg.MeshCentralEnabled {
			meshGw, err = meshcentral.NewGateway(cfg, database, sig.PeerMap(), sig.EventBus(), jwtSecret)
			if err != nil {
				log.Fatalf("Failed to init MeshCentral gateway: %v", err)
			}
			meshGw.SetBlocklist(blocklist)
			meshGw.SetAuditLogger(auditLogger)
			meshGw.SetJWTManager(jwtManager)
			meshGw.SetVersion(Version)
			// Web cert hash: MESH_WEB_CERT_FILE (public TLS agents see, e.g. proxy LE)
			// takes priority over TLS_CERT (may be internal/signal-only).
			webCertPath := cfg.MeshWebCertFile
			if webCertPath == "" {
				webCertPath = cfg.TLSCertFile
			}
			if webCertPath != "" {
				if certBytes, readErr := os.ReadFile(webCertPath); readErr == nil {
					if h := meshcentral.WebCertHash(certBytes); len(h) > 0 {
						meshGw.SetWebCertHash(h)
						log.Printf("[mesh] web cert hash loaded from %s", webCertPath)
					} else {
						log.Printf("[mesh] warning: could not parse web cert at %s — web hash validation skipped", webCertPath)
					}
				} else {
					log.Printf("[mesh] warning: cannot read web cert %s: %v — web hash validation skipped", webCertPath, readErr)
				}
			}
			apiSrv.SetMeshGateway(meshGw)
		}

		if err := apiSrv.Start(ctx); err != nil {
			log.Fatalf("Failed to start API server: %v", err)
		}
		defer apiSrv.Stop()

		if cdapGw != nil {
			if err := cdapGw.Start(ctx); err != nil {
				log.Fatalf("Failed to start CDAP gateway: %v", err)
			}
			defer cdapGw.Stop()
		}

		if meshGw != nil {
			if err := meshGw.Start(ctx); err != nil {
				log.Fatalf("Failed to start MeshCentral gateway: %v", err)
			}
			defer meshGw.Stop()
		}

		adminSrv.SetPeerMap(sig.PeerMap())
		if cfg.AdminPassword != "" {
			adminSrv.SetAdminPassword(cfg.AdminPassword)
		}
		if err := adminSrv.Start(ctx); err != nil {
			log.Printf("WARN: Failed to start admin interface: %v", err)
		}
		defer adminSrv.Stop()

	case "signal":
		log.Printf("Starting signal + API servers...")
		sig := sigServer.New(cfg, kp, database)
		sig.SetBlocklist(blocklist)
		sig.SetRateLimiter(ipLimiter)
		sig.SetAuditLogger(auditLogger)
		if err := sig.Start(ctx); err != nil {
			log.Fatalf("Failed to start signal server: %v", err)
		}
		defer sig.Stop()

		apiSrv := api.New(cfg, database, sig.PeerMap(), nil, Version)
		defer attachPanelSync(apiSrv, billingSvc, database, cfg.DBPath, cfg.AuthDBPath)()
		apiSrv.SetBlocklist(blocklist)
		apiSrv.SetBandwidthLimiter(bwLimiter)
		apiSrv.SetAuditLogger(auditLogger)
		apiSrv.SetEventBus(sig.EventBus())
		apiSrv.SetMetrics(mc)
		apiSrv.SetJWTManager(jwtManager)
		apiSrv.SetKeyPair(kp)
		apiSrv.InitLDAP()
		apiSrv.InitOIDC()
		if err := apiSrv.Start(ctx); err != nil {
			log.Fatalf("Failed to start API server: %v", err)
		}
		defer apiSrv.Stop()

		adminSrv.SetPeerMap(sig.PeerMap())
		if err := adminSrv.Start(ctx); err != nil {
			log.Printf("WARN: Failed to start admin interface: %v", err)
		}
		defer adminSrv.Stop()

	case "relay":
		log.Printf("Starting relay server only...")
		relaySrv := relay.New(cfg)
		relaySrv.SetBandwidthLimiter(bwLimiter)
		if connLimiter != nil {
			relaySrv.SetConnLimiter(connLimiter)
		}
		if sessionLimiter != nil {
			relaySrv.SetSessionLimiter(sessionLimiter)
		}
		if err := relaySrv.Start(ctx); err != nil {
			log.Fatalf("Failed to start relay server: %v", err)
		}
		defer relaySrv.Stop()

	default:
		log.Fatalf("Unknown mode: %s (use: all, signal, relay)", cfg.Mode)
	}

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	osSignal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	log.Printf("Received signal %v, shutting down...", sig)
	cancel()
	log.Printf("Server stopped")
}

func ensureScopedAPIKey(database db.Database, apiKey string) error {
	if strings.TrimSpace(apiKey) == "" {
		return nil
	}
	hash := sha256.Sum256([]byte(apiKey))
	hashHex := hex.EncodeToString(hash[:])
	if existing, err := database.GetAPIKeyByHash(hashHex); err == nil && existing != nil {
		return nil
	}
	key := &db.APIKey{
		KeyHash:   hashHex,
		KeyPrefix: apiKey[:min(len(apiKey), 8)],
		Name:      "console-bridge",
		Role:      auth.RoleAdmin,
	}
	return database.CreateAPIKey(key)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func writeBootstrapAdminCredentials(dbDir, adminUser, adminPass string) (string, error) {
	if dbDir == "" || dbDir == "." {
		dbDir = "."
	}
	credsFile := filepath.Join(dbDir, ".admin_credentials")
	credsContent := fmt.Sprintf(
		"Admin Username: %s\nAdmin Password: %s\n\nChange this password immediately and delete this file!\n",
		adminUser, adminPass,
	)
	if err := os.WriteFile(credsFile, []byte(credsContent), 0600); err != nil {
		return "", err
	}
	return credsFile, nil
}

func syncAPIKeyToServerConfig(database db.Database, apiKey string) (string, error) {
	existing, _ := database.GetConfig("api_key")
	if existing == apiKey {
		return "unchanged", nil
	}
	if err := database.SetConfig("api_key", apiKey); err != nil {
		return "failed", err
	}
	if existing == "" {
		return "stored", nil
	}
	return "updated", nil
}

func logAPIKeySyncOutcome(source, outcome string, syncErr error) {
	switch outcome {
	case "unchanged":
		log.Printf("API key loaded from %s (already in database)", source)
	case "stored":
		log.Printf("API key loaded from %s and stored in database", source)
	case "updated":
		log.Printf("API key loaded from %s and updated in database", source)
	case "failed":
		if syncErr != nil {
			log.Printf("WARN: Failed to sync API key to server_config: %v", syncErr)
		} else {
			log.Printf("WARN: Failed to sync API key to server_config")
		}
	}
}

// loadAPIKey reads the API key from API_KEY environment variable or .api_key file
// in the key file directory (and DB directory as fallback), and syncs it to the
// database's server_config table. This ensures the Node.js console and Go server
// share the same API key regardless of how the server was started.
func loadAPIKey(cfg *config.Config, database db.Database) {
	var apiKey string
	var source string

	// 1. Check API_KEY environment variable (highest priority)
	if v := os.Getenv("API_KEY"); v != "" {
		apiKey = strings.TrimSpace(v)
		source = "API_KEY env var"
	}

	// 2. Check .api_key file in key file directory
	if apiKey == "" {
		keyDir := filepath.Dir(cfg.KeyFile)
		if keyDir == "" || keyDir == "." {
			keyDir = "."
		}
		apiKeyFile := filepath.Join(keyDir, ".api_key")
		if data, err := os.ReadFile(apiKeyFile); err == nil {
			apiKey = strings.TrimSpace(string(data))
			if apiKey != "" {
				source = ".api_key file (key directory)"
			}
		}
	}

	// 3. Check .api_key file in database directory as fallback
	if apiKey == "" {
		dbDir := filepath.Dir(cfg.DBPath)
		if dbDir == "" || dbDir == "." {
			dbDir = "."
		}
		apiKeyFile := filepath.Join(dbDir, ".api_key")
		if data, err := os.ReadFile(apiKeyFile); err == nil {
			apiKey = strings.TrimSpace(string(data))
			if apiKey != "" {
				source = ".api_key file (database directory)"
			}
		}
	}

	// 4. Check database server_config table (may have been set previously)
	if apiKey == "" {
		if existing, _ := database.GetConfig("api_key"); existing != "" {
			apiKey = existing
			source = "database server_config"
		}
	}

	// 5. Auto-generate if nothing found anywhere
	if apiKey == "" {
		b := make([]byte, 32)
		if _, err := cryptoRand.Read(b); err != nil {
			log.Printf("WARN: Failed to generate API key: %v. Console→Server auth will fail.", err)
			return
		}
		apiKey = hex.EncodeToString(b)
		source = "auto-generated"

		// Write to key file directory so Node.js console can read it
		keyDir := filepath.Dir(cfg.KeyFile)
		if keyDir == "" || keyDir == "." {
			keyDir = "."
		}
		apiKeyFile := filepath.Join(keyDir, ".api_key")
		if err := os.WriteFile(apiKeyFile, []byte(apiKey+"\n"), 0600); err != nil {
			log.Printf("WARN: Auto-generated API key but failed to write .api_key file in key directory: %v", err)
			// Still try to store in DB even if file write fails
		} else {
			log.Printf("Auto-generated API key written to .api_key file in key directory")
		}
	}

	outcome, syncErr := syncAPIKeyToServerConfig(database, apiKey)
	logAPIKeySyncOutcome(source, outcome, syncErr)

	// Always ensure the scoped API key exists in api_keys table.
	// This is critical — authenticateRequest() checks ONLY the api_keys table.
	if err := ensureScopedAPIKey(database, apiKey); err != nil {
		log.Printf("WARN: Failed to migrate API key into scoped api_keys table: %v", err)
	} else {
		log.Printf("API key is available in scoped api_keys table")
	}
}

// resolveAuthDBPath finds legacy console auth.db (SQLite-only deployments).
// PostgreSQL deployments use PanelSyncStore on the primary database instead.
func resolveAuthDBPath(explicit, dbPath string) string {
	if strings.TrimSpace(explicit) != "" {
		return explicit
	}
	candidates := []string{
		"/opt/BetterDeskConsole/data/auth.db",
		"/opt/rustdesk/../BetterDeskConsole/data/auth.db",
	}
	if v := os.Getenv("CONSOLE_DATA_DIR"); v != "" {
		candidates = append(candidates, filepath.Join(v, "auth.db"))
	}
	if v := os.Getenv("DATA_DIR"); v != "" {
		candidates = append(candidates, filepath.Join(v, "auth.db"))
	}
	if v := os.Getenv("BETTERDESK_AUTH_DB_PATH"); v != "" {
		candidates = append(candidates, v)
	}
	if dbPath != "" && !strings.HasPrefix(dbPath, "postgres") {
		dir := filepath.Dir(dbPath)
		candidates = append(candidates,
			filepath.Join(dir, "auth.db"),
			filepath.Join(dir, "../data/auth.db"),
			filepath.Join(dir, "../../BetterDeskConsole/data/auth.db"),
			filepath.Join(dir, "../BetterDeskConsole/data/auth.db"),
		)
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return explicit
}

// attachPanelSync wires RustDesk group/folder sync to PostgreSQL, the
// consolidated SQLite store, or a legacy auth.db during the migration window.
func attachPanelSync(apiSrv *api.Server, billingSvc *billing.Service, database db.Database, primaryDBPath, authDBPath string) func() {
	if pg, ok := database.(*db.PostgresDB); ok {
		apiSrv.SetPanelStore(pg)
		if billingSvc != nil {
			billingSvc.SetPanelSyncStore(pg)
		}
		log.Printf("RustDesk panel sync: PostgreSQL (device groups, folders, ACL)")
		return func() {}
	}
	if _, ok := database.(*db.SQLiteDB); ok {
		consolidated, err := db.SQLiteAuthConsolidated(primaryDBPath)
		if err != nil {
			log.Printf("WARN: cannot determine SQLite consolidation state: %v", err)
		} else if consolidated {
			authDBPath = primaryDBPath
			log.Printf("RustDesk panel sync: consolidated SQLite database")
		}
	}
	if strings.TrimSpace(authDBPath) == "" {
		log.Printf("WARN: no panel sync source — device groups/folders unavailable to RustDesk client")
		return func() {}
	}
	consoleAuth, err := db.OpenConsoleAuth(authDBPath)
	if err != nil {
		log.Printf("WARN: console auth.db not opened (%s): %v — RustDesk groups from panel may be missing", authDBPath, err)
		return func() {}
	}
	apiSrv.SetPanelStore(consoleAuth)
	if billingSvc != nil {
		billingSvc.SetPanelSyncStore(consoleAuth)
	}
	log.Printf("RustDesk panel sync: legacy auth.db at %s", authDBPath)
	return func() { _ = consoleAuth.Close() }
}

func parseFlags() *config.Config {
	cfg := config.DefaultConfig()

	flag.IntVar(&cfg.SignalPort, "port", cfg.SignalPort, "Signal server port (UDP+TCP)")
	flag.IntVar(&cfg.RelayPort, "relay-port", cfg.RelayPort, "Relay server port (TCP)")
	flag.IntVar(&cfg.APIPort, "api-port", cfg.APIPort, "HTTP API port")
	flag.StringVar(&cfg.Mode, "mode", cfg.Mode, "Server mode: all, signal, relay")
	flag.StringVar(&cfg.DBPath, "db", cfg.DBPath, "Database DSN: SQLite path or postgres://... URI")
	flag.StringVar(&cfg.KeyFile, "key-file", cfg.KeyFile, "Ed25519 key file path (without extension)")
	flag.StringVar(&cfg.RelayServers, "relay-servers", cfg.RelayServers, "Comma-separated relay server addresses")
	flag.StringVar(&cfg.RendezvousServers, "rendezvous-servers", cfg.RendezvousServers, "Comma-separated rendezvous server addresses")
	flag.StringVar(&cfg.Mask, "mask", cfg.Mask, "LAN mask (e.g. 192.168.0.0/24)")
	flag.BoolVar(&cfg.AlwaysUseRelay, "always-relay", cfg.AlwaysUseRelay, "Always use relay (skip hole punching)")
	flag.StringVar(&cfg.BlocklistFile, "blocklist", cfg.BlocklistFile, "Path to blocklist file (IP/ID/CIDR entries)")
	flag.StringVar(&cfg.AuditLogFile, "audit-log", cfg.AuditLogFile, "Path to audit log file (JSON lines)")
	flag.StringVar(&cfg.TLSCertFile, "tls-cert", cfg.TLSCertFile, "Path to TLS certificate file")
	flag.StringVar(&cfg.TLSKeyFile, "tls-key", cfg.TLSKeyFile, "Path to TLS key file")
	flag.StringVar(&cfg.LogFormat, "log-format", cfg.LogFormat, "Log format: text (default) or json")
	flag.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "Log level: error, warn, info (default), debug")
	flag.IntVar(&cfg.AdminPort, "admin-port", cfg.AdminPort, "TCP admin interface port (0 = disabled)")
	flag.StringVar(&cfg.JWTSecret, "jwt-secret", cfg.JWTSecret, "JWT signing secret (auto-generated if empty)")
	flag.IntVar(&cfg.JWTExpiry, "jwt-expiry", cfg.JWTExpiry, "JWT token expiry in hours (default 24)")
	flag.BoolVar(&runSQLiteAuthConsolidation, "migrate-sqlite-auth", false, "Safely consolidate legacy auth.db into the selected SQLite DB, then exit")
	flag.BoolVar(&sqliteAuthConsolidationDryRun, "migrate-sqlite-auth-dry-run", false, "Validate legacy auth.db consolidation without modifying databases")
	flag.StringVar(&sqliteAuthConsolidationBackupDir, "migrate-sqlite-auth-backup-dir", "", "Directory for SQLite auth consolidation backups")
	flag.StringVar(&sqliteAuthConsolidationRollback, "rollback-sqlite-auth", "", "Restore the selected SQLite DB from a consolidation snapshot, then exit")
	flag.StringVar(&cfg.AdminPassword, "admin-password", cfg.AdminPassword, "Password for admin TCP interface")
	flag.BoolVar(&cfg.ForceHTTPS, "force-https", cfg.ForceHTTPS, "Reject non-TLS API requests")
	flag.BoolVar(&cfg.TrustProxy, "trust-proxy", cfg.TrustProxy, "Trust X-Forwarded-For/X-Real-IP headers from reverse proxy (requires --trusted-proxies)")
	trustedProxiesFlag := flag.String("trusted-proxies", "", "Comma-separated CIDR/IP allowlist of reverse proxies that may set X-Forwarded-* (required with --trust-proxy)")
	flag.IntVar(&cfg.RelayMaxConnsIP, "relay-max-conns-ip", cfg.RelayMaxConnsIP, "Max relay connections per IP (0 = unlimited)")
	flag.IntVar(&cfg.SignalRateLimitPerIP, "signal-rate-limit-per-ip", cfg.SignalRateLimitPerIP, "Max signal registrations per IP per minute (0 = unlimited; raise for large NAT deployments — issue #122)")
	flag.BoolVar(&cfg.SameNATRelay, "same-nat-relay", cfg.SameNATRelay, "Auto-fallback to relay when both peers share the same public IP (avoids NAT hairpin failures — issue #121)")
	flag.BoolVar(&cfg.P2PFirst, "p2p-first", cfg.P2PFirst, "Wait for the target's hole punch before answering the initiator so direct P2P can succeed (issue #157; disable to always answer immediately)")
	flag.IntVar(&cfg.P2PFallbackMs, "p2p-fallback-ms", cfg.P2PFallbackMs, "Grace period (ms) to wait for the target's PunchHoleSent before sending the relay fallback response (only with --p2p-first)")
	flag.StringVar(&cfg.InitAdminUser, "init-admin-user", cfg.InitAdminUser, "Initial admin username (default: admin)")
	flag.StringVar(&cfg.InitAdminPass, "init-admin-pass", cfg.InitAdminPass, "Initial admin password (auto-generated if empty)")
	flag.BoolVar(&cfg.TLSSignal, "tls-signal", cfg.TLSSignal, "Enable TLS on signal TCP/WS ports (requires --tls-cert and --tls-key)")
	flag.BoolVar(&cfg.TLSRelay, "tls-relay", cfg.TLSRelay, "Enable TLS on relay TCP/WS ports (requires --tls-cert and --tls-key)")
	flag.BoolVar(&cfg.TLSApi, "tls-api", cfg.TLSApi, "Enable TLS on HTTP API port (requires --tls-cert and --tls-key)")
	flag.IntVar(&cfg.CDAPPort, "cdap-port", cfg.CDAPPort, "CDAP WebSocket gateway port (default 21122)")
	flag.BoolVar(&cfg.CDAPEnabled, "cdap", cfg.CDAPEnabled, "Enable CDAP gateway for custom devices")
	flag.BoolVar(&cfg.CDAPTLS, "tls-cdap", cfg.CDAPTLS, "Enable TLS on CDAP gateway port (requires --tls-cert and --tls-key)")

	showVersion := flag.Bool("version", false, "Show version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("betterdesk-server %s (built %s)\n", Version, BuildDate)
		os.Exit(0)
	}

	// Override with environment variables
	cfg.LoadEnv()
	cfg.AuthDBPath = resolveAuthDBPath(cfg.AuthDBPath, cfg.DBPath)

	// CLI --trusted-proxies overrides env when set (LoadEnv already applied TRUSTED_PROXIES).
	if *trustedProxiesFlag != "" {
		nets, err := config.ParseTrustedProxies(*trustedProxiesFlag)
		if err != nil {
			log.Fatalf("Invalid --trusted-proxies: %v", err)
		}
		cfg.TrustedProxies = nets
	}
	cfg.WarnProxyTrustMisconfig()

	// Validate mode
	cfg.Mode = strings.ToLower(cfg.Mode)
	if cfg.Mode != "all" && cfg.Mode != "signal" && cfg.Mode != "relay" {
		log.Fatalf("Invalid mode: %s (must be: all, signal, relay)", cfg.Mode)
	}

	return cfg
}
