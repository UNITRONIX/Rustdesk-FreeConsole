/**
 * BetterDesk Console - Rate Limiter Middleware
 */

const rateLimit = require('express-rate-limit');
const config = require('../config/config');

const defaultKeyGenerator = (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown';

/**
 * Authenticated panel read/poll endpoints (dashboard widgets, status cards).
 * GET/HEAD only — mutations still use the general apiLimiter budget.
 *
 * Mounted with widgetLimiter in server.js and skipped by apiLimiter so the
 * 100/min general cap does not starve normal console usage.
 */
const PANEL_POLL_PATHS = new Set([
    '/api/stats',
    '/api/server/status',
    '/api/server/bandwidth',
    '/api/devices',
    '/api/audit/conn',
    '/api/dashboard/client-config',
    '/api/dashboard/activity',
    '/api/registrations/count',
    '/api/network/targets',
    '/api/tickets/stats',
    '/api/cdap/devices',
    '/api/users',
    '/api/audit-log',
    '/api/system/info',
    '/api/logs/recent',
    '/api/database/stats',
    '/api/docker/containers',
    '/api/folders',
    '/api/tags',
    '/api/device-groups',
    '/api/bd/notifications'
]);

/** Prefixes for read-only dashboard sub-routes (future-safe). */
const PANEL_POLL_PREFIXES = [
    '/api/dashboard/',
    '/api/panel/'
];

function isPanelPollRequest(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const path = req.path || '';
    if (PANEL_POLL_PATHS.has(path)) return true;
    return PANEL_POLL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Session-authenticated UI preference writes (desktop layout save). */
function isPanelPreferenceWrite(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') return false;
    return (req.path || '') === '/api/desktop/layout';
}

/** Paths that receive widgetLimiter in server.js (exact paths only). */
function getPanelPollMountPaths() {
    return Array.from(PANEL_POLL_PATHS);
}

/**
 * General API rate limiter.
 *
 * SECURITY (audit fix M-03, 2026-04-10): the previous Referer-based skip was
 * removed because Referer is fully client-controlled. High-frequency widget /
 * dashboard refresh endpoints now have their own higher-quota limiter
 * (`widgetLimiter`) that the panel routes opt into explicitly.
 */
const apiLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many requests. Please try again later.'
    },
    keyGenerator: defaultKeyGenerator,
    skip: (req) => isPanelPollRequest(req) || isPanelPreferenceWrite(req)
});

/**
 * Widget / dashboard refresh limiter. Higher quota (600 req/min by default)
 * because the panel polls many widgets in parallel. Still authenticated —
 * mount only on routes that require an active session.
 */
const widgetLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.WIDGET_RATE_LIMIT_MAX, 10) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many widget requests. Please slow down.'
    },
    keyGenerator: defaultKeyGenerator
});

/**
 * Desktop layout / wallpaper preference saves (session + CSRF, debounced in UI).
 */
const panelPreferenceLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.PANEL_PREFERENCE_RATE_LIMIT_MAX, 10) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many layout save requests. Please slow down.'
    },
    keyGenerator: (req) => {
        const userId = req.session && req.session.userId;
        if (userId) return `pref:${userId}`;
        return defaultKeyGenerator(req);
    }
});

/**
 * RdClient HTML page limiter. Keeps remote viewer/login pages bounded without
 * using the stricter credential-attempt budget.
 */
const rdClientPageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RDCLIENT_PAGE_RATE_LIMIT_MAX, 10) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many remote page requests. Please slow down.'
    },
    keyGenerator: defaultKeyGenerator
});

/**
 * Strict rate limiter for login attempts
 */
const loginLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many login attempts. Please try again in a minute.'
    },
    keyGenerator: (req) => {
        return req.ip || req.headers['x-forwarded-for'] || 'unknown';
    }
});

/**
 * Very strict limiter for password changes
 */
const passwordChangeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many password change attempts. Please try again later.'
    }
});

/**
 * Upload / mutation limiter for ticket and file endpoints.
 */
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX, 10) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many upload requests. Please try again later.'
    },
    keyGenerator: defaultKeyGenerator
});

/**
 * File-system read/download limiter (language files, theme presets, completed transfers).
 */
const fileAccessLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.FILE_ACCESS_RATE_LIMIT_MAX, 10) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many file requests. Please try again later.'
    },
    keyGenerator: defaultKeyGenerator
});

module.exports = {
    apiLimiter,
    widgetLimiter,
    panelPreferenceLimiter,
    rdClientPageLimiter,
    loginLimiter,
    passwordChangeLimiter,
    uploadLimiter,
    fileAccessLimiter,
    isPanelPollRequest,
    isPanelPreferenceWrite,
    getPanelPollMountPaths,
    PANEL_POLL_PATHS
};
