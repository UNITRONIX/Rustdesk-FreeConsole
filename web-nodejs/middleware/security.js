/**
 * BetterDesk Console - Security Middleware
 * Configures Helmet and custom security headers
 */

const crypto = require('crypto');
const helmet = require('helmet');
const config = require('../config/config');

/**
 * Build CSP connect-src based on HTTPS mode
 * Allow WebSocket connections (ws:// or wss:// depending on mode)
 */
const connectSources = config.httpsEnabled
    ? ["'self'", "wss:", "https://cdn.jsdelivr.net"]
    : ["'self'", "ws:", "https://cdn.jsdelivr.net"];

/**
 * HSTS is disabled for self-signed / LAN installs so HTTP↔HTTPS toggles do not
 * leave a year-long browser enforcement (#219). Set HSTS_ENABLED=true to force it.
 */
function shouldSendStrictTransportSecurity() {
    if (!config.httpsEnabled) return false;
    const hstsEnv = String(process.env.HSTS_ENABLED || '').toLowerCase();
    if (hstsEnv === 'false' || hstsEnv === '0' || hstsEnv === 'off') return false;
    if (hstsEnv === 'true' || hstsEnv === '1' || hstsEnv === 'on') return true;
    return !config.allowSelfSignedCerts;
}

function buildHelmetMiddleware(req, res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const isRemoteViewerPage = req.path.startsWith('/remote');

    res.locals.cspNonce = nonce;

    const scriptSources = ["'self'", `'nonce-${nonce}'`, "https://cdn.jsdelivr.net"];
    if (isRemoteViewerPage) {
        // The remote viewer still depends on protobuf.js runtime code generation.
        scriptSources.push("'unsafe-eval'");
    }

    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: scriptSources,
                // Allow inline event handlers (onclick=, onchange=, etc.) used by
                // several admin panel pages. <script> tags still require nonce.
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "blob:"],
                mediaSrc: ["'self'", "blob:"],
                connectSrc: connectSources,
                frameSrc: ["'self'"],
                objectSrc: ["'none'"],
                childSrc: ["'self'"],
                workerSrc: ["'self'", "blob:"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
                upgradeInsecureRequests: config.httpsEnabled ? [] : null
            }
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-origin' },
        crossOriginOpenerPolicy: config.httpsEnabled ? { policy: 'same-origin' } : false,
        originAgentCluster: config.httpsEnabled,
        strictTransportSecurity: shouldSendStrictTransportSecurity()
            ? { maxAge: 31536000, includeSubDomains: true, preload: false }
            : false,
        dnsPrefetchControl: { allow: false },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    });
}

/**
 * Custom security headers beyond what Helmet provides
 */
function customSecurityHeaders(req, res, next) {
    // Prevent clickjacking (belt + suspenders with CSP frame-ancestors)
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // XSS Protection (disabled — CSP is the modern replacement)
    res.setHeader('X-XSS-Protection', '0');

    // Permissions policy — restrict powerful APIs
    // Only use standardized features; non-standard ones (browsing-topics,
    // attribution-reporting, private-state-token-*, etc.) cause console warnings.
    res.setHeader('Permissions-Policy',
        'geolocation=(), microphone=(self), camera=(), ' +
        'payment=(), usb=(), ' +
        'accelerometer=(), gyroscope=(), magnetometer=()');

    // Prevent cross-site leak via cache timing
    res.setHeader('Cache-Control', 'no-store');
    // Allow static assets to be cached (overridden in express.static options)
    if (req.path.startsWith('/css/') || req.path.startsWith('/js/') ||
        req.path.startsWith('/img/') || req.path.startsWith('/fonts/')) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    next();
}

/**
 * Combined security middleware
 */
function securityMiddleware(req, res, next) {
    buildHelmetMiddleware(req, res)(req, res, () => {
        customSecurityHeaders(req, res, next);
    });
}

module.exports = securityMiddleware;
