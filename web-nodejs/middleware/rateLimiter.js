/**
 * BetterDesk Console - Rate Limiter Middleware
 */

const rateLimit = require('express-rate-limit');
const config = require('../config/config');

const defaultKeyGenerator = (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown';

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
    keyGenerator: defaultKeyGenerator
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
    rdClientPageLimiter,
    loginLimiter,
    passwordChangeLimiter,
    uploadLimiter,
    fileAccessLimiter
};
