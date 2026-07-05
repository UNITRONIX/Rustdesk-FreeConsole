/**
 * BetterDesk Console - WAN API Security Middleware
 * 
 * Hardened security layer for the internet-facing RustDesk Client API (port 21121).
 * This middleware stack is applied ONLY to the dedicated API port, not the admin panel.
 * 
 * Security layers:
 *   1. Request size limit (per-path body size limits)
 *   2. Strict CORS (no browser access)
 *   3. Security headers (no information leakage)
 *   4. JSON-only content type enforcement
 *   5. Path whitelist (strict endpoint list)
 *   6. Rate limiting (aggressive per-IP + audit-specific)
 *   7. Request timeout (10s max)
 * 
 * @author UNITRONIX
 * @version 2.0.0 — expanded for sysinfo/audit/groups/strategies/server-key
 */

const rateLimit = require('express-rate-limit');

/**
 * Allowed paths on the WAN API port.
 * Everything else returns 404 — zero attack surface.
 */
const ALLOWED_PATHS = new Set([
    // Phase 0: Core auth
    '/api/login',
    '/api/logout',
    '/api/currentUser',
    '/api/login-options',
    // Phase 1: Core integration
    '/api/heartbeat',
    '/api/sysinfo',
    '/api/sysinfo_ver',
    '/api/peers',
    // Phase 2: Audit
    '/api/audit',
    '/api/audit/conn',
    '/api/audit/file',
    '/api/audit/alarm',
    // Phase 3: Groups & strategies
    '/api/device-group',
    '/api/device-group/accessible',
    '/api/user/group',
    '/api/user-groups',
    '/api/strategies',
    '/api/strategies/assign',
    '/api/devices',
    // Address book
    '/api/ab',
    '/api/ab/personal',
    '/api/ab/tags',
    // Users & software
    '/api/users',
    '/api/software',
    '/api/software/client-download-link',
    // Security: server key distribution
    '/api/server-key',
    '/api/server-key/fingerprint',
    // RustDesk PRO group endpoints (Flutter client queries after login)
    '/api/group',
    '/api/group/get',
    '/api/peers/list',
    // LAN registration
    '/api/bd/register-request',
    '/api/bd/register-status'
]);

/**
 * Dynamic path patterns (regex) for endpoints with parameters.
 * Checked when exact match fails.
 */
const ALLOWED_PATH_PATTERNS = [
    /^\/api\/peer-key\/[a-zA-Z0-9_-]{1,32}$/,
    /^\/api\/strategies\/[0-9a-f-]{36}$/i,
    /^\/api\/strategies\/[0-9a-f-]{36}\/status$/i,
    /^\/api\/devices\/[0-9a-f-]{36}\/assign$/i
];

const ALLOWED_METHODS = {
    '/api/login': 'POST',
    '/api/logout': 'POST',
    '/api/currentUser': 'GET',
    '/api/login-options': 'GET',
    '/api/heartbeat': 'POST',
    '/api/sysinfo': 'POST',
    '/api/sysinfo_ver': 'POST',
    '/api/peers': 'GET',
    '/api/audit': 'GET',
    '/api/audit/conn': '*',
    '/api/audit/file': '*',
    '/api/audit/alarm': '*',
    '/api/device-group': '*',
    '/api/device-group/accessible': 'GET',
    '/api/user/group': 'GET',
    '/api/user-groups': '*',
    '/api/strategies': '*',
    '/api/strategies/assign': 'POST',
    '/api/devices': 'GET',
    '/api/ab': '*',
    '/api/ab/personal': '*',
    '/api/ab/tags': 'GET',
    '/api/users': 'GET',
    '/api/software': 'GET',
    '/api/software/client-download-link': 'GET',
    '/api/server-key': 'GET',
    '/api/server-key/fingerprint': 'GET',
    '/api/group': '*',
    '/api/group/get': '*',
    '/api/peers/list': '*',
    '/api/bd/register-request': 'POST',
    '/api/bd/register-status': 'GET'
};

/**
 * Per-path body size limits in bytes.
 * Paths not listed use the default MAX_BODY_SIZE.
 */
const PATH_BODY_LIMITS = {
    '/api/login': 4096,           // 4KB — login with deviceInfo payload
    '/api/sysinfo': 8192,         // 8KB — sysinfo with displays/encoding data
    '/api/sysinfo_ver': 512,      // 512B — version check (id + hash only)
    '/api/ab': 524288,             // 512KB — match Go address book limit
    '/api/ab/personal': 524288,    // 512KB — personal address book
    '/api/audit/conn': 2048,      // 2KB — connection event
    '/api/audit/file': 4096,      // 4KB — file transfer event (file list)
    '/api/audit/alarm': 2048,     // 2KB — alarm event
    '/api/device-group': 2048,    // 2KB — group create/update
    '/api/user-groups': 2048,     // 2KB — group create/update
    '/api/strategies': 4096,      // 4KB — strategy with permissions JSON
    '/api/group': 2048,           // 2KB — RustDesk PRO group endpoint
    '/api/group/get': 2048,       // 2KB — RustDesk PRO group fetch
    '/api/peers/list': 2048       // 2KB — RustDesk PRO peer list
};

/**
 * Default maximum request body size in bytes
 */
const MAX_BODY_SIZE = 1024;

/**
 * Path whitelist — reject any request not matching allowed endpoints
 */
function pathWhitelist(req, res, next) {
    // Check exact match first
    if (!ALLOWED_PATHS.has(req.path)) {
        // Check regex patterns for parameterized routes
        const matched = ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(req.path));
        if (!matched) {
            return res.status(404).end();
        }
        // Dynamic paths allow GET only
        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
            return res.status(405).end();
        }
        return next();
    }

    // Enforce correct HTTP method (* allows any method)
    const expectedMethod = ALLOWED_METHODS[req.path];
    if (expectedMethod && expectedMethod !== '*' && req.method !== expectedMethod && req.method !== 'OPTIONS') {
        return res.status(405).end();
    }

    next();
}

/**
 * Security headers for WAN-facing API
 * Strips all unnecessary information, prevents caching
 */
function securityHeaders(req, res, next) {
    // Remove server identification
    res.removeHeader('X-Powered-By');

    // Prevent caching of API responses (tokens, user data)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), usb=()');

    // Strict Content-Security-Policy (no HTML/JS/CSS on this port)
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

    // CORS — restrictive (RustDesk desktop client doesn't need CORS)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    next();
}

/**
 * Content-Type enforcement — only accept application/json for POST
 */
function jsonOnly(req, res, next) {
    if (req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
            return res.status(415).json({ error: 'Content-Type must be application/json' });
        }
    }
    next();
}

/**
 * Request body size limit — with per-path overrides
 */
function bodySizeLimit(req, res, next) {
    let size = 0;
    let rejected = false;
    const maxSize = PATH_BODY_LIMITS[req.path] || MAX_BODY_SIZE;

    req.on('data', (chunk) => {
        if (rejected) return;
        size += chunk.length;
        if (size > maxSize) {
            rejected = true;
            // Send error response BEFORE destroying the request stream.
            // Calling req.destroy() first would close the socket and prevent
            // the 413 response from reaching the client (causes IncompleteMessage).
            if (!res.headersSent) {
                res.status(413).json({ error: 'Request too large' });
            }
            req.destroy();
        }
    });

    next();
}

/**
 * Request timeout — prevent slow loris attacks
 */
function requestTimeout(req, res, next) {
    req.setTimeout(10000, () => {
        res.status(408).end();
    });
    next();
}

/**
 * Aggressive rate limiter for the WAN API port
 * 5 requests per minute per IP for login, 20 globally
 */
const wanLoginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 5, // 5 attempts per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
    keyGenerator: (req) => req.ip || 'unknown',
    skip: (req) => {
        // Only rate-limit login and logout, not currentUser or login-options
        return req.path !== '/api/login' && req.path !== '/api/logout';
    }
});

/**
 * Global rate limiter for all API endpoints on this port
 */
const wanGlobalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 requests per IP per minute total (increased for heartbeat + sysinfo + audit)
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    keyGenerator: (req) => req.ip || 'unknown'
});

/**
 * Audit-specific rate limiter — prevent log flooding attacks
 * 20 audit events per IP per minute
 */
const wanAuditLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Audit rate limit exceeded' },
    keyGenerator: (req) => req.ip || 'unknown',
    skip: (req) => {
        // Only apply to POST audit endpoints
        return !req.path.startsWith('/api/audit/') || req.method !== 'POST';
    }
});

/**
 * Log all requests to this port (security audit trail)
 */
function requestLogger(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const msg = `[API:${req.method}] ${req.path} ${res.statusCode} ${duration}ms IP:${ip}`;

        if (res.statusCode >= 400) {
            console.warn(msg);
        } else {
            console.log(msg);
        }
    });

    next();
}

/**
 * Get the complete middleware stack for WAN API
 * Apply these in order to the Express app on port 21121
 */
function getWanMiddlewareStack() {
    return [
        requestTimeout,
        securityHeaders,
        requestLogger,
        pathWhitelist,
        wanGlobalLimiter,
        wanAuditLimiter,
        wanLoginLimiter,
        bodySizeLimit,
        jsonOnly
    ];
}

module.exports = {
    pathWhitelist,
    securityHeaders,
    jsonOnly,
    bodySizeLimit,
    requestTimeout,
    wanLoginLimiter,
    wanGlobalLimiter,
    wanAuditLimiter,
    requestLogger,
    getWanMiddlewareStack
};
