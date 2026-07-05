/**
 * BetterDesk Console - Server Entry Point
 * Professional Web Management Panel for RustDesk Server
 * 
 * @author UNITRONIX
 * @version 2.1.0
 * @license AGPL-3.0
 */

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const config = require('./config/config');
const securityMiddleware = require('./middleware/security');
const { initI18n } = require('./middleware/i18n');
const { apiLimiter, widgetLimiter, getPanelPollMountPaths } = require('./middleware/rateLimiter');
const { csrfTokenProvider, doubleCsrfProtection, downgradeToHttp: csrfDowngradeToHttp } = require('./middleware/csrf');
const { roleHasPermission, isSuperAdminRole } = require('./middleware/auth');
const authService = require('./services/authService');
const serverBackend = require('./services/serverBackend');
const db = require('./services/database');
const userSync = require('./services/userSync');
const { initWsProxy } = require('./services/wsRelay');
const { initBdRelay } = require('./services/bdRelay');
const { initChatRelay } = require('./services/chatRelay');
const { apiClient: goApiClient } = require('./services/betterdeskApi');
const { initRemoteRelay } = require('./services/remoteRelay');
const { initCdapTerminalProxy } = require('./services/cdapTerminalProxy');
const { initCdapMediaProxies } = require('./services/cdapMediaProxy');
const { initMeshAshxProxy } = require('./services/meshAshxProxy');
const { startDiscoveryService } = require('./services/lanDiscovery');
const { initDeviceStatusPush } = require('./services/deviceStatusPush');
const { initHelpRequestEmailService } = require('./services/helpRequestEmailService');
const routes = require('./routes');
const rustdeskApiRoutes = require('./routes/rustdesk-api.routes');
const bdApiRoutes = require('./routes/bd-api.routes');
const { getWanMiddlewareStack } = require('./middleware/wanSecurity');
const { parseTrustProxy } = require('./lib/parseTrustProxy');
const {
    resolvePortForCurrentUser,
    attachPrivilegedPortErrorHandler,
} = require('./lib/privilegedPorts');

// Create Express app
const app = express();

// Trust proxy (for rate limiting behind reverse proxy)
// Configurable via TRUST_PROXY env var: false/0=off, 1/true=single proxy, 'loopback'=localhost only
// Default: false (safest). Set TRUST_PROXY=1 when behind nginx/Apache/cloudflare
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxy);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure data directory exists (required before auth.db / session secret)
try {
    if (!fs.existsSync(config.dataDir)) {
        fs.mkdirSync(config.dataDir, { recursive: true });
    }
} catch (err) {
    console.error(`Failed to create data directory (${config.dataDir}): ${err.message}`);
    console.error('If the console runs as a dedicated user, run: sudo node scripts/linux-ensure-console-user.js');
    process.exit(1);
}

// ============ Middleware Pipeline ============

// Security headers (Helmet)
app.use(securityMiddleware);

// CORS for BetterDesk desktop clients (Tauri webview origins)
app.use('/api/', (req, res, next) => {
    const origin = req.headers.origin || '';
    const allowed = [
        'http://localhost:1420',    // Tauri dev
        'tauri://localhost',        // Tauri production (macOS/Linux)
        'https://tauri.localhost',  // Tauri production (Windows)
    ];
    if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-CSRF-Token');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Body parsing (2MB limit for base64 logo images)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Cookie parsing
app.use(cookieParser());

// Session management — also kept as a standalone middleware ref for WebSocket upgrades
// Use a different cookie name in HTTP mode to avoid collision with stale
// Secure cookies left over from a previous HTTPS configuration (Issue #82).
const SESSION_COOKIE = config.httpsEnabled ? 'betterdesk.sid' : 'bd.sid';
const sessionMiddleware = session({
    secret: config.sessionSecret,
    name: SESSION_COOKIE,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: config.httpsEnabled,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: config.sessionMaxAge
    }
});
app.use(sessionMiddleware);

// Cache version — changes on every restart/deployment, stable during runtime.
// Used in ?v= query strings so browsers cache assets per deployment.
app.locals.cacheVersion = config.appVersion + '.' + Date.now();

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProduction ? '7d' : '0',
    etag: true
}));

// Serve proto files for remote client (protobufjs dynamic loading)
app.use('/protos', express.static(path.join(__dirname, 'protos'), {
    maxAge: config.isProduction ? '7d' : '0',
    etag: true
}));

// Serve uploaded branding assets (logos etc.) from persistent data dir
const uploadsDir = path.join(config.dataDir || path.join(__dirname, 'data'), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, {
    maxAge: config.isProduction ? '30d' : '0',
    etag: true
}));

// Serve desktop wallpapers
app.use('/wallpapers', express.static(path.join(__dirname, 'wallpapers'), {
    maxAge: config.isProduction ? '30d' : '0',
    etag: true,
    immutable: true
}));

// Rate limiting for API.
// SECURITY (audit fix M-03, 2026-04-10): high-frequency widget refresh paths
// have their own higher-quota limiter mounted BEFORE the general one so they
// are still bounded but do not eat into the regular API budget.
for (const p of getPanelPollMountPaths()) {
    app.use(p, widgetLimiter);
}
app.use('/api/', apiLimiter);

// RustDesk Client API — mounted BEFORE CSRF because desktop clients use Bearer
// token auth, not cookie-based CSRF.  These routes are also served on the
// dedicated WAN-facing port (21121) with additional hardening.
app.use(rustdeskApiRoutes);

// BetterDesk Desktop Client API — device-facing endpoints that use
// Bearer token or X-Device-Id header, not browser CSRF cookies.
app.use('/api/bd', bdApiRoutes);

// i18n middleware
app.use(initI18n());

// Embed mode — when ?embed=1 is present, layout renders without sidebar/navbar
// Used by Desktop Mode to load pages inside floating windows (iframes)
app.use((req, res, next) => {
    res.locals.embed = req.query.embed === '1';
    // Inject permission helper for EJS templates (sidebar/button visibility)
    const role = req.session?.user?.role;
    res.locals.hasPermission = (perm) => role ? roleHasPermission(role, perm) : false;
    res.locals.isSuperAdmin = role ? isSuperAdminRole(role) : false;
    // Prevent HTML page caching — only static assets should be cached
    if (!req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|proto)$/)) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
});

// CSRF protection — generate token for views, validate on POST/PUT/DELETE/PATCH.
// Skip CSRF for device-facing API routes (/api/bd/*) — these MUST authenticate
// via Bearer access token (session-cookie fallback is rejected in requireDeviceAuth).
//
// SECURITY (audit fix C-02, 2026-04-10): the previous Origin-based CSRF skip
// for Tauri webview origins (`tauri://localhost`, `https://tauri.localhost`,
// `http://localhost:1420`) was removed — `Origin` is freely forgeable by any
// non-browser HTTP client, so it is unsafe as a CSRF-bypass signal. Tauri
// desktop clients receive the CSRF token via `csrfTokenProvider` and must
// echo it back in the `X-CSRF-Token` header (csrf-csrf double-submit).
app.use(csrfTokenProvider);
app.use((req, res, next) => {
    if (req.path.startsWith('/api/bd/')) {
        return next();
    }
    doubleCsrfProtection(req, res, next);
});

// ============ Routes ============

app.use('/', routes);

// ============ Error Handlers ============

// CSRF token mismatch
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN' || err.message?.includes('csrf') || err.message?.includes('CSRF')) {
        res.status(403);
        // Detect likely SSL→HTTP transition: cookie missing because browser held Secure cookie
        const likelySslTransition = !config.httpsEnabled && !req.secure;
        const hint = likelySslTransition
            ? ' If you recently disabled SSL, clear your browser cookies for this site and reload.'
            : '';
        // Always return JSON for API routes (fetch sends Accept: */*)
        if (req.path.startsWith('/api/') || (req.headers['content-type'] && req.headers['content-type'].includes('application/json'))) {
            return res.json({ success: false, error: 'Invalid CSRF token. Please refresh the page and try again.' + hint });
        }
        if (req.accepts('html')) {
            return res.render('errors/500', {
                title: 'Forbidden',
                activePage: 'error',
                error: 'Invalid or missing CSRF token. Please refresh the page and try again.' + hint
            });
        }
        return res.json({ success: false, error: 'Invalid CSRF token' + hint });
    }
    next(err);
});

// 404 Not Found
app.use((req, res, next) => {
    res.status(404);

    // Log unmatched /api/* and /ws/* paths only (avoid noise from missing
    // static assets like favicons).  Diagnostics suggestion credit:
    // progloto (PR #81).
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/ws/')) {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        const ua = String(req.headers['user-agent'] || '').slice(0, 80);
        console.warn(`[panel] 404 ${req.method} ${req.originalUrl} from ${ip} ua="${ua}"`);
    }

    if (req.accepts('html')) {
        res.render('errors/404', {
            title: req.t ? req.t('errors.not_found') : 'Not Found',
            activePage: 'error'
        });
    } else {
        res.json({
            success: false,
            error: 'Not Found'
        });
    }
});

// 500 Server Error
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    
    res.status(err.status || 500);
    
    // Always return JSON for API routes
    if (req.path.startsWith('/api/') || (req.headers['content-type'] && req.headers['content-type'].includes('application/json'))) {
        return res.json({
            success: false,
            error: config.isProduction ? 'Internal Server Error' : err.message
        });
    }
    
    if (req.accepts('html')) {
        res.render('errors/500', {
            title: req.t ? req.t('errors.server_error') : 'Server Error',
            activePage: 'error',
            error: config.isProduction ? null : err.message
        });
    } else {
        res.json({
            success: false,
            error: config.isProduction ? 'Internal Server Error' : err.message
        });
    }
});

// ============ Startup ============

/**
 * Warn if the user set Go-server-only TLS env vars in the Node.js environment.
 * These variables (TLS_CERT, TLS_KEY) are read exclusively by the Go server.
 * The Node.js console uses SSL_CERT_PATH / SSL_KEY_PATH instead.
 * Silently ignoring them causes issue #104 — port 21121 stays HTTP while the
 * RustDesk client expects HTTPS, producing InvalidContentType errors.
 */
function warnGoTlsEnvVars() {
    const hasTlsCert = !!process.env.TLS_CERT;
    const hasTlsKey  = !!process.env.TLS_KEY;
    if (!hasTlsCert && !hasTlsKey) return;

    const hasSslCertPath = !!process.env.SSL_CERT_PATH;
    const hasSslKeyPath  = !!process.env.SSL_KEY_PATH;

    if (hasTlsCert || hasTlsKey) {
        console.warn('');
        console.warn('  ┌─────────────────────────────────────────────────────┐');
        console.warn('  │  ⚠  MISCONFIGURATION WARNING — TLS / SSL           │');
        console.warn('  ├─────────────────────────────────────────────────────┤');
        console.warn('  │  TLS_CERT / TLS_KEY are Go server environment       │');
        console.warn('  │  variables and are IGNORED by this Node.js console. │');
        console.warn('  │                                                     │');
        console.warn('  │  To enable HTTPS on this console set:               │');
        console.warn('  │    SSL_CERT_PATH=/path/to/fullchain.pem             │');
        console.warn('  │    SSL_KEY_PATH=/path/to/privkey.pem                │');
        console.warn('  │                                                     │');
        if (!hasSslCertPath && !hasSslKeyPath) {
            console.warn('  │  ❌ SSL_CERT_PATH and SSL_KEY_PATH are NOT set.    │');
            console.warn('  │     Port 21121 (RustDesk Client API) is HTTP.     │');
            console.warn('  │     Clients connecting via HTTPS will fail with   │');
            console.warn('  │     InvalidContentType errors.                    │');
        } else {
            console.warn('  │  ✅ SSL_CERT_PATH / SSL_KEY_PATH are set — OK.    │');
        }
        console.warn('  └─────────────────────────────────────────────────────┘');
        console.warn('');
    }
}

/**
 * Load SSL certificates for HTTPS
 */
function loadSslCertificates() {
    const options = {};
    
    if (!config.sslCertPath || !config.sslKeyPath) {
        return null;
    }
    
    try {
        if (!fs.existsSync(config.sslCertPath)) {
            console.error(`SSL certificate not found: ${config.sslCertPath}`);
            return null;
        }
        if (!fs.existsSync(config.sslKeyPath)) {
            console.error(`SSL private key not found: ${config.sslKeyPath}`);
            return null;
        }
        
        options.cert = fs.readFileSync(config.sslCertPath);
        options.key = fs.readFileSync(config.sslKeyPath);
        
        // Optional CA bundle (for Let's Encrypt chain)
        if (config.sslCaPath && fs.existsSync(config.sslCaPath)) {
            options.ca = fs.readFileSync(config.sslCaPath);
        }
        
        return options;
    } catch (err) {
        console.error('Failed to load SSL certificates:', err.message);
        return null;
    }
}

function attachPlainHttpTlsHint(server, port) {
    server.on('tlsClientError', (err, socket) => {
        const message = String(err && err.message || '');
        const looksLikePlainHttp = /wrong version number|http request|unknown protocol|packet length/i.test(message);
        if (!looksLikePlainHttp || !socket || socket.destroyed) return;

        const body = JSON.stringify({
            error: `RustDesk Client API on port ${port} requires HTTPS. Use https://<server>:${port}.`
        });
        const response = [
            'HTTP/1.1 400 Bad Request',
            'Content-Type: application/json; charset=utf-8',
            'Cache-Control: no-store',
            'Connection: close',
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body
        ].join('\r\n');

        try {
            socket.end(response);
        } catch (_) {
            socket.destroy();
        }
        console.warn(`RustDesk API: rejected plain HTTP on HTTPS port ${port}`);
    });
}

function shouldUseRustDeskApiTls(sslOptions) {
    const mode = String(config.rustdeskApiTls || 'auto').toLowerCase();
    if (mode === 'false' || mode === '0' || mode === 'off' || mode === 'http') return false;
    if (mode === 'true' || mode === '1' || mode === 'on' || mode === 'https') return !!sslOptions;
    return !!sslOptions;
}

/**
 * Create HTTP redirect server (redirects all HTTP to HTTPS)
 */
function createHttpRedirectServer(httpsPort) {
    const redirectApp = express();
    redirectApp.use((req, res) => {
        const httpsUrl = `https://${req.hostname}:${httpsPort}${req.url}`;
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(307, httpsUrl);
    });
    
    return http.createServer(redirectApp);
}

async function startServer() {
    // Warn early about common TLS misconfiguration (Go env vars used instead of Node.js vars)
    warnGoTlsEnvVars();

    try {
        // Initialize database adapter (creates tables, runs migrations)
        await db.init();

        // Warm branding cache from database (must run after db.init)
        const brandingService = require('./services/brandingService');
        await brandingService.loadBranding();

        // Recover/sync global users before deciding whether a default admin is needed.
        // This protects upgrades where local auth.db was recreated but Go still has users.
        await userSync.backfillFromGo();

        // Ensure default admin exists
        await authService.ensureDefaultAdmin();

        // Keep Go organization-linkable users aligned with the panel store.
        await userSync.backfillFromNode();
        
        let server;
        let protocol = 'http';
        const listenPort = resolvePortForCurrentUser(config.port, 5000, 'HTTP');
        const listenHttpsPort = resolvePortForCurrentUser(config.httpsPort, 5443, 'HTTPS');
        let displayPort = listenPort;
        
        // HTTPS mode
        if (config.httpsEnabled) {
            const sslOptions = loadSslCertificates();
            
            if (sslOptions) {
                // Create HTTPS server
                server = https.createServer(sslOptions, app);
                protocol = 'https';
                displayPort = listenHttpsPort;
                
                attachPrivilegedPortErrorHandler(server, { port: listenHttpsPort, label: 'HTTPS' });
                server.listen(listenHttpsPort, config.host, () => {
                    printStartupBanner(protocol, displayPort);
                });
                
                // Optionally start HTTP redirect server
                if (config.httpRedirect) {
                    const redirectServer = createHttpRedirectServer(listenHttpsPort);
                    attachPrivilegedPortErrorHandler(redirectServer, { port: listenPort, label: 'HTTP redirect' });
                    redirectServer.listen(listenPort, config.host, () => {
                        console.log(`  HTTP -> HTTPS redirect active on port ${listenPort}`);
                        console.log('');
                    });
                    
                    // Graceful shutdown for redirect server too
                    const shutdownRedirect = () => { redirectServer.close(); };
                    process.on('SIGTERM', shutdownRedirect);
                    process.on('SIGINT', shutdownRedirect);
                }
            } else {
                console.warn('WARNING: HTTPS enabled but certificates not found/invalid');
                console.warn('Falling back to HTTP mode');
                console.warn('  → Session and CSRF cookies downgraded to non-Secure');
                console.warn('  → Fix: check SSL_CERT_PATH and SSL_KEY_PATH in .env');
                
                // BD-2026-082: Downgrade cookie flags to match actual HTTP mode.
                // Session middleware was initialised with secure:true at module
                // load time.  Without this fixup, browsers would ignore all
                // cookies and every request would fail CSRF validation.
                if (sessionMiddleware && sessionMiddleware.options) {
                    sessionMiddleware.options.cookie = sessionMiddleware.options.cookie || {};
                    sessionMiddleware.options.cookie.secure = false;
                }
                csrfDowngradeToHttp();
                
                server = http.createServer(app);
                attachPrivilegedPortErrorHandler(server, { port: listenPort, label: 'HTTP' });
                server.listen(listenPort, config.host, () => {
                    printStartupBanner(protocol, listenPort);
                });
            }
        } else {
            // HTTP mode (default)
            server = http.createServer(app);
            attachPrivilegedPortErrorHandler(server, { port: listenPort, label: 'HTTP' });
            server.listen(listenPort, config.host, () => {
                printStartupBanner(protocol, listenPort);
            });
        }
        
        // Initialize WebSocket proxy for remote desktop client
        initWsProxy(server, sessionMiddleware);

        // Initialize BetterDesk native relay (WebSocket)
        initBdRelay(server);

        // Initialize Chat relay (WebSocket — agent ↔ operator, persistent via Go API)
        initChatRelay(server, sessionMiddleware, goApiClient);

        // Initialize Remote Desktop relay (WebSocket — agent JPEG ↔ browser viewer)
        initRemoteRelay(server, sessionMiddleware);

        // Initialize CDAP Terminal WebSocket proxy (browser ↔ Go server)
        initCdapTerminalProxy(server, sessionMiddleware);

        // Initialize CDAP Media WebSocket proxies (desktop, video, file browser)
        initCdapMediaProxies(server, sessionMiddleware);

        initMeshAshxProxy(server, sessionMiddleware);

        // Initialize real-time device status push (Go event bus → browser)
        initDeviceStatusPush(server, sessionMiddleware, config.betterdeskApiUrl, config.betterdeskApiKey);
        initHelpRequestEmailService(config.betterdeskApiUrl, config.betterdeskApiKey);

        // Start LAN Discovery UDP service
        startDiscoveryService();
        try {
            const panelDiscovery = require('./services/panelDiscovery');
            panelDiscovery.startPanelMdns();
        } catch (err) {
            console.warn('[server] mDNS panel discovery disabled:', err.message);
        }

        // Start branded agent installer build worker (Generator Agenta / Phase 2).
        // Disabled when AGENT_BUILD_WORKER=off — useful for hosts without the
        // build toolchain (e.g. small consoles that only proxy to a build node).
        if (process.env.AGENT_BUILD_WORKER !== 'off') {
            try {
                const agentBuildWorker = require('./services/agentBuildWorker');
                agentBuildWorker.startWorker();
            } catch (err) {
                console.warn('[server] agent build worker disabled:', err.message);
            }
        }
        if (process.env.RDCLIENT_BUILD_WORKER !== 'off') {
            try {
                const rdclientBuildWorker = require('./services/rdclientBuildWorker');
                rdclientBuildWorker.startWorker();
            } catch (err) {
                console.warn('[server] rdclient build worker disabled:', err.message);
            }
        }
        if (process.env.AGENT_CLIENT_BUILD_WORKER !== 'off') {
            try {
                const agentClientBuildWorker = require('./services/agentClientBuildWorker');
                agentClientBuildWorker.startWorker();
            } catch (err) {
                console.warn('[server] agent-client build worker disabled:', err.message);
            }
        }
        
        // ============ RustDesk Client API (WAN :21121 → Go :21114 proxy) ============
        let apiServer = null;
        if (config.apiEnabled) {
            apiServer = startRustDeskApiServer();
        } else if (config.serverBackend === 'betterdesk') {
            console.log(`  ║   Client API: disabled — use :${config.apiPort} proxy or Go :${config.goApiPort}`.padEnd(53) + '║');
        }
        
        // ============ Periodic Housekeeping ============
        const housekeepingInterval = setInterval(async () => {
            await authService.cleanupHousekeeping();
            // Clean up old integration data (metrics >7d, audit >90d)
            try {
                await db.runIntegrationHousekeeping();
            } catch (err) {
                // Silent fail — don't crash the server for housekeeping
            }
            // Clean up old audit_log entries (>90 days)
            try {
                if (typeof db.cleanupOldAuditLogs === 'function') {
                    await db.cleanupOldAuditLogs(90);
                }
            } catch (err) {
                // Silent fail
            }
        }, 60 * 60 * 1000); // Every hour
        
        // ============ Periodic Online Status Sync ============
        const syncInterval = parseInt(process.env.STATUS_SYNC_INTERVAL, 10) || 15; // seconds
        const heartbeatStaleThreshold = parseInt(process.env.HEARTBEAT_STALE_THRESHOLD, 10) || 90; // seconds
        const statusSyncInterval = setInterval(async () => {
            try {
                await serverBackend.syncOnlineStatus();
            } catch (err) {
                // Silent fail - don't crash the server
            }
            // Also clean up stale heartbeat-based online status
            try {
                if (typeof db.cleanupStaleOnlinePeers === 'function') {
                    await db.cleanupStaleOnlinePeers(heartbeatStaleThreshold);
                }
            } catch (err) {
                // Silent fail
            }
        }, syncInterval * 1000);
        
        // Initial sync on startup (after short delay for HBBS to be ready)
        setTimeout(async () => {
            try {
                const result = await serverBackend.syncOnlineStatus();
                if (result.synced > 0) {
                    console.log(`Initial status sync: ${result.synced} device(s) online`);
                }
            } catch (err) {
                // Silent fail
            }
        }, 5000);
        
        // Graceful shutdown
        const shutdown = (signal) => {
            console.log(`\n${signal} received. Shutting down gracefully...`);
            clearInterval(housekeepingInterval);
            clearInterval(statusSyncInterval);
            
            const closePromises = [new Promise(r => server.close(r))];
            if (apiServer) {
                closePromises.push(new Promise(r => apiServer.close(r)));
            }
            
            Promise.all(closePromises).then(() => {
                console.log('All servers closed.');
                process.exit(0);
            });
            
            // Force exit after 10 seconds
            setTimeout(() => {
                console.error('Forced shutdown after timeout');
                process.exit(1);
            }, 10000);
        };
        
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

/**
 * Start the dedicated RustDesk Client API server on a separate port.
 * This is a minimal, hardened Express app with only 4 endpoints.
 * Designed for WAN/internet exposure with aggressive security.
 */
function startRustDeskApiServer() {
    const apiApp = express();
    const { goApiProxy, getGoApiOrigin } = require('./middleware/goApiProxy');
    const useGoProxy = config.apiProxyToGo && config.serverBackend === 'betterdesk';

    // Trust proxy (use same configuration as main app — TRUST_PROXY env var)
    apiApp.set('trust proxy', trustProxy);

    // Apply WAN security middleware stack
    const wanMiddleware = getWanMiddlewareStack();
    for (const mw of wanMiddleware) {
        apiApp.use(mw);
    }

    if (useGoProxy) {
        // LAN registration is still handled in Node (not on Go API)
        const registrationRoutes = require('./routes/registration.routes');
        apiApp.use('/api/bd', registrationRoutes);
        // /api/group* → Go (JWT from /api/login). Node requireAuth only accepts 64-char auth.db tokens.
        apiApp.use(goApiProxy);
    } else {
        // Legacy: Node implements RustDesk API locally (SQLite-era deployments)
        apiApp.use(express.json({ limit: '64kb', strict: true }));
        apiApp.use('/', rustdeskApiRoutes);
        const registrationRoutes = require('./routes/registration.routes');
        apiApp.use('/api/bd', registrationRoutes);
    }

    // Catch-all for any unmatched routes (should not reach here due to pathWhitelist).
    // We log every miss so missing RustDesk client compatibility endpoints are
    // easy to spot in operations.  Diagnostics suggestion credit:
    // progloto (PR #81).
    apiApp.use((req, res) => {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        const ua = String(req.headers['user-agent'] || '').slice(0, 80);
        console.warn(`[rustdesk-api] 404 ${req.method} ${req.originalUrl} from ${ip} ua="${ua}"`);
        res.status(404).end();
    });

    // Error handler — never leak internal errors
    apiApp.use((err, req, res, next) => {
        if (err.type === 'entity.parse.failed') {
            console.warn('RustDesk API: JSON parse error from', req.socket?.remoteAddress);
            return res.status(400).json({ error: 'Invalid JSON' });
        }
        if (err.type === 'entity.too.large') {
            return res.status(413).json({ error: 'Request too large' });
        }
        console.error('RustDesk API error:', err.message);
        res.status(500).json({ error: 'Server error' });
    });

    // Start HTTP or HTTPS server for RustDesk Client API. By default TLS is used
    // when certs are available, but self-signed deployments may set
    // RUSTDESK_API_TLS=false because stock RustDesk clients cannot trust a
    // private CA here. Keep that exception explicit: it affects only :21121.
    let apiServerInstance;
    const sslOptions = loadSslCertificates();
    const useApiTls = shouldUseRustDeskApiTls(sslOptions);
    if (useApiTls) {
        apiServerInstance = https.createServer(sslOptions, apiApp);
        attachPlainHttpTlsHint(apiServerInstance, config.apiPort);
        console.log(`  ║   API TLS:   Enabled (HTTPS on :${config.apiPort})`.padEnd(53) + '║');
    } else {
        if ((config.sslCertPath || config.sslKeyPath) && config.rustdeskApiTls !== 'false') {
            console.warn(`WARNING: SSL certs configured but invalid — API running insecure HTTP on :${config.apiPort}`);
        }
        if (sslOptions && String(config.rustdeskApiTls || '').toLowerCase() === 'false') {
            console.warn(`WARNING: RUSTDESK_API_TLS=false — RustDesk Client API is HTTP on :${config.apiPort}. Use only behind a trusted network/VPN or with a low-privilege account.`);
        }
        apiServerInstance = http.createServer(apiApp);
    }
    
    apiServerInstance.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`  ║   API Port:  ${config.apiPort} FAILED (port in use)`.padEnd(53) + '║');
            console.error(`  ║   Hint: Check if hbbs uses the same port, or`.padEnd(53) + '║');
            console.error(`  ║   set API_PORT env var (default: 21121)`.padEnd(53) + '║');
            console.log('  ║                                                  ║');
            console.error(`WARNING: RustDesk Client API could not start on port ${config.apiPort}`);
            console.error('Likely cause: hbbs API is on the same port. Client API default is 21121.');
            console.error('The admin panel continues to run normally on port ' + config.port);
            return; // Don't crash — let the panel continue running
        }
        if (err.code === 'EACCES') {
            console.error(`WARNING: RustDesk Client API could not bind port ${config.apiPort} (permission denied)`);
            console.error('Ports below 1024 require root or CAP_NET_BIND_SERVICE — set API_PORT to a high port.');
            return;
        }
        throw err;
    });
    
    apiServerInstance.listen(config.apiPort, config.apiHost, () => {
        if (useGoProxy) {
            console.log(`  ║   Client API:  :${config.apiPort} → Go ${getGoApiOrigin()}`.padEnd(53) + '║');
        } else {
            console.log(`  ║   Client API:  :${config.apiPort} (Node local handlers)`.padEnd(53) + '║');
        }
        console.log('  ║                                                  ║');
    });

    // Set connection timeout (prevent slow loris)
    apiServerInstance.headersTimeout = 15000;
    apiServerInstance.requestTimeout = 10000;
    apiServerInstance.keepAliveTimeout = 5000;

    return apiServerInstance;
}

/**
 * Print startup banner with server info
 */
function printStartupBanner(protocol, port) {
    const sslStatus = config.httpsEnabled ? '🔒 HTTPS' : '🔓 HTTP';
    // API port 21121 can use a separate TLS mode for RustDesk client compatibility.
    const apiHasCerts = config.sslCertPath && config.sslKeyPath && 
                        fs.existsSync(config.sslCertPath) && fs.existsSync(config.sslKeyPath);
    const apiProtocol = shouldUseRustDeskApiTls(apiHasCerts ? {} : null) ? 'HTTPS' : 'HTTP';
    const apiStatus = config.apiEnabled ? `✅ Port ${config.apiPort} (${apiProtocol})` : '❌ Disabled';
    const panelUrl = `${protocol}://${config.host}:${port}`;
    const goApiUrl = redactUrlForLog(config.betterdeskApiUrl || process.env.BETTERDESK_API_URL || 'http://localhost:21114/api');
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║                                                  ║');
    console.log('  ║   🖥️  BetterDesk Console v' + config.appVersion.padEnd(23) + '  ║');
    console.log('  ║                                                  ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║                                                  ║');
    console.log(`  ║   Panel:      ${panelUrl}`.padEnd(53) + '║');
    if (config.httpsEnabled && config.httpRedirect) {
        console.log(`  ║   Redirect:   http://${config.host}:${config.port} → :${config.httpsPort}`.padEnd(53) + '║');
    }
    console.log(`  ║   Client API: ${apiStatus}`.padEnd(53) + '║');
    console.log(`  ║   Go API:     ${goApiUrl}`.padEnd(53) + '║');
    console.log(`  ║   Mode:       ${config.nodeEnv}`.padEnd(53) + '║');
    console.log(`  ║   Security:   ${sslStatus}`.padEnd(53) + '║');
    const dbLabel = (db.DB_TYPE === 'postgres' || db.DB_TYPE === 'postgresql')
        ? `PostgreSQL (${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'localhost'})`
        : path.basename(config.dbPath);
    console.log(`  ║   Database:   ${dbLabel}`.padEnd(53) + '║');
    console.log(`  ║   Keys:       ${config.keysPath}`.padEnd(53) + '║');
    console.log('  ║                                                  ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');

    // BD-2026-006: Warn if panel is bound to all interfaces in non-Docker environments
    if (config.host === '0.0.0.0' && !config.isDocker) {
        console.log('  ⚠️  WARNING [SECURITY]: Panel bound to 0.0.0.0 (all interfaces).');
        console.log('     Set HOST=127.0.0.1 in .env to restrict to localhost only.');
        console.log('');
    }

    // BD-2026-008: Warn if plaintext credentials file exists
    const credFile = path.join(config.keysPath, '.admin_credentials');
    if (fs.existsSync(credFile)) {
        console.log('  ⚠️  WARNING [SECURITY]: Plaintext .admin_credentials file detected.');
        console.log('     Delete it after noting the password: ' + credFile);
        console.log('');
    }

    // BD-2026-009: Warn when proxy trust is enabled
    if (trustProxy && trustProxy !== false && trustProxy !== 0) {
        console.log('  ⚠️  NOTICE [SECURITY]: TRUST_PROXY is enabled (' + trustProxy + ').');
        console.log('     Ensure a trusted reverse proxy sets X-Forwarded-For correctly.');
        console.log('');
    }

    // L-01 (audit 2026-04-10): warn about disabled proxy trust in production
    // — rate limiters and audit logs will see the proxy IP, not the client IP.
    if (process.env.NODE_ENV === 'production' && (!trustProxy || trustProxy === false || trustProxy === 0)) {
        console.log('  ⚠️  WARNING [SECURITY]: NODE_ENV=production but TRUST_PROXY is disabled.');
        console.log('     If the panel is behind a reverse proxy (nginx, Cloudflare, ALB,');
        console.log('     Traefik…) rate-limit keys and audit logs will record the proxy IP,');
        console.log('     not the real client IP. Set TRUST_PROXY=1 (single proxy) or a CIDR list.');
        console.log('');
    }

    // H-04 (audit 2026-04-10): unconditional banner when the RustDesk client
    // API TOTP bypass is enabled, regardless of acknowledgement — the bypass
    // weakens 2FA on the WAN-facing :21121 endpoint and operators MUST be
    // aware of it on every restart.
    if (config.rustdeskApiDisableTotp) {
        if (!config.rustdeskApiDisableTotpAck) {
            console.log('  ⛔  ERROR  [SECURITY]: RUSTDESK_API_DISABLE_TOTP=true but ACK flag is missing.');
            console.log('     The bypass is IGNORED. Set RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED=true');
            console.log('     to confirm you accept disabling 2FA on the RustDesk client login.');
            console.log('');
        } else {
            console.log('  ⚠️  WARNING [SECURITY]: TOTP is DISABLED on the RustDesk client API (:21121).');
            console.log('     RustDesk desktop clients can log in with username+password only.');
            console.log('     The web panel still enforces 2FA independently.');
            console.log('');
        }
    }
}

function redactUrlForLog(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';

    try {
        const parsed = new URL(value);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch (_) {
        return value.replace(/\/\/[^/@]+@/, '//***@');
    }
}

// Start the server
startServer();

module.exports = app;
