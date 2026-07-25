'use strict';

/**
 * OIDC Redirect URL helpers for panel settings and IdP registration (#304).
 *
 * After the panel proxies /api/auth/oidc/callback → Go, operators may use either
 * the console origin (e.g. :5000 / :5443) or the Go/Client API origin
 * (:21114 / :21121). The path must still be the stock callback path.
 */

const CALLBACK_PATHS = new Set([
    '/api/auth/oidc/callback',
    '/api/oidc/callback',
]);

/**
 * @param {string} raw
 * @returns {{ ok: true, url: URL, pathname: string } | { ok: false, reason: string }}
 */
function parseOidcRedirectUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, reason: 'empty' };
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: 'scheme' };
    }
    const pathname = (url.pathname || '/').replace(/\/+$/, '') || '/';
    if (!CALLBACK_PATHS.has(pathname)) {
        return { ok: false, reason: 'path' };
    }
    return { ok: true, url, pathname };
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isValidOidcRedirectUrl(raw) {
    return parseOidcRedirectUrl(raw).ok === true;
}

/**
 * Suggest a Redirect URL based on the panel origin operators already use.
 * @param {string} panelOrigin e.g. https://host:5443
 * @returns {string}
 */
function suggestOidcRedirectUrl(panelOrigin) {
    const base = String(panelOrigin || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    try {
        const u = new URL(base);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        return `${u.origin}/api/auth/oidc/callback`;
    } catch {
        return '';
    }
}

module.exports = {
    CALLBACK_PATHS,
    parseOidcRedirectUrl,
    isValidOidcRedirectUrl,
    suggestOidcRedirectUrl,
};
