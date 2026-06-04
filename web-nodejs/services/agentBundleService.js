/**
 * Agent installer bundle service
 *
 * Responsible for:
 *   - validating + normalizing branding payloads supplied by operators
 *     in the "Generator Agenta" panel
 *   - hashing the normalized branding (Phase 2 build-artifact cache key)
 *   - generating short, URL-safe bundle IDs
 *
 * The build pipeline itself (Tauri cross-compile, dpkg-deb, rpmbuild,
 * appimagetool, cargo-xwin + wine) is intentionally NOT implemented here.
 * Phase 1 stores the bundle definition + serves a public download portal
 * that reports each platform as "pending". Phase 2 will plug a queue
 * into this service and start producing real artifacts keyed by
 * `branding_hash`.
 */

'use strict';

const crypto = require('crypto');
const conn = require('./agentBundleConnection');

// Supported delivery targets. The portal renders one card per entry.
const PLATFORMS = [
    { platform: 'windows', arch: 'x64', format: 'portable',  label: 'Windows portable (.zip)' },
    { platform: 'windows', arch: 'x64', format: 'installed', label: 'Windows installed (.exe)' },
    { platform: 'linux',   arch: 'x64', format: 'portable',  label: 'Linux universal portable (.tar.gz)' },
    { platform: 'linux',   arch: 'x64', format: 'appimage',  label: 'Linux portable (AppImage)' },
    { platform: 'linux',   arch: 'x64', format: 'installed', label: 'Linux Debian/Ubuntu (.deb)' },
    { platform: 'linux',   arch: 'x64', format: 'rpm',       label: 'Linux Fedora/RHEL (.rpm)' },
];

const SUPPORTED_LANGS = ['en', 'pl', 'zh-TW'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Reasonable upper bounds: enough room for a base64 PNG/SVG logo (~10 MB),
// not enough to be a DoS vector.
const MAX_LOGO_BYTES = 10 * 1024 * 1024;  // 10 MB encoded
const MAX_SHORT_TEXT = 500;
const MAX_NAME       = 100;
const MAX_CONTACT    = 200;

function clip(input, max) {
    if (typeof input !== 'string') return '';
    return input.trim().slice(0, max);
}

function isDataUrlImage(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    if (!s.startsWith('data:image/')) return false;
    const idx = s.indexOf(';base64,');
    if (idx === -1) return false;
    if (Buffer.byteLength(s, 'utf8') > MAX_LOGO_BYTES) return false;
    return true;
}

function isLikelyUrl(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * Validate + normalize a branding payload from the operator panel.
 * Returns { valid, errors[], normalized }
 */
function validateBranding(input = {}) {
    const errors = [];
    const out = {};

    out.company_name = clip(input.company_name || input.companyName, MAX_NAME);
    if (!out.company_name) errors.push('company_name_required');

    out.short_text   = clip(input.short_text   || input.shortText,   MAX_SHORT_TEXT);
    out.contact_email = clip(input.contact_email || input.contactEmail, MAX_CONTACT);
    out.contact_phone = clip(input.contact_phone || input.contactPhone, MAX_CONTACT);
    out.contact_url   = clip(input.contact_url   || input.contactUrl,   MAX_CONTACT);

    if (out.contact_url) {
        // UX: auto-prepend https:// if the operator typed a bare domain
        // (e.g. "insolve.pl") so the most common input still validates.
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(out.contact_url)) {
            const candidate = 'https://' + out.contact_url;
            if (isLikelyUrl(candidate)) {
                out.contact_url = candidate;
            }
        }
        if (!isLikelyUrl(out.contact_url)) {
            errors.push('contact_url_invalid');
        }
    }

    const logo = input.logo_data_url || input.logoDataUrl || '';
    if (logo) {
        if (!isDataUrlImage(logo)) {
            errors.push('logo_invalid');
            out.logo_data_url = '';
        } else {
            out.logo_data_url = logo;
        }
    } else {
        out.logo_data_url = '';
    }

    out.primary_color = (input.primary_color || input.primaryColor || '#2563eb');
    if (!HEX_COLOR.test(out.primary_color)) {
        errors.push('primary_color_invalid');
        out.primary_color = '#2563eb';
    }
    out.primary_color = out.primary_color.toLowerCase();

    out.accent_color = (input.accent_color || input.accentColor || '#1e293b');
    if (!HEX_COLOR.test(out.accent_color)) {
        errors.push('accent_color_invalid');
        out.accent_color = '#1e293b';
    }
    out.accent_color = out.accent_color.toLowerCase();

    const colorFields = [
        ['background_color', '#0f172a', 'background_color'],
        ['surface_color', '#1e293b', 'surface_color'],
        ['text_color', '#e2e8f0', 'text_color'],
        ['text_muted_color', '#94a3b8', 'text_muted_color'],
        ['status_ready_color', '#22c55e', 'status_ready_color'],
        ['header_text_color', '#ffffff', 'header_text_color'],
    ];
    for (const [key, fallback, errKey] of colorFields) {
        const alt = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        out[key] = (input[key] || input[alt] || fallback);
        if (!HEX_COLOR.test(out[key])) {
            errors.push(errKey + '_invalid');
            out[key] = fallback;
        }
        out[key] = out[key].toLowerCase();
    }

    out.allow_unattended = !!(input.allow_unattended ?? input.allowUnattended ?? false);

    out.default_lang = String(input.default_lang || input.defaultLang || 'en');
    if (!SUPPORTED_LANGS.includes(out.default_lang)) {
        out.default_lang = 'en';
    }

    // Connection profile — host/TLS set by operator; URLs + token filled server-side.
    out.server_host = clip(input.server_host || input.serverHost, 253);
    if (out.server_host) {
        const norm = conn.normalizeServerHost(out.server_host);
        if (!norm.valid) {
            errors.push(norm.error);
        } else {
            out.server_host = norm.host;
        }
    } else {
        errors.push('server_host_required');
    }
    out.use_https = !!(input.use_https ?? input.useHttps ?? conn.defaultUseHttps());

    // Never accept enrollment_token from the browser — issued by backend only.
    if (input.server && typeof input.server === 'object') {
        out.server = {
            address:    clip(input.server.address    || '', MAX_CONTACT),
            api_url:    clip(input.server.api_url    || '', MAX_CONTACT),
            public_key: clip(input.server.public_key || '', 256),
        };
    } else {
        out.server = { address: '', api_url: '', public_key: '' };
    }

    return { valid: errors.length === 0, errors, normalized: out };
}

/**
 * Stable hash of normalized branding. Sorts keys recursively so logically
 * identical branding produces an identical hash regardless of insertion order.
 * Used as the Phase 2 cache key — bundles sharing this hash reuse artifacts.
 */
function hashBranding(normalized) {
    const json = stableStringify(normalized || {});
    return crypto.createHash('sha256').update(json).digest('hex');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 12 hex chars = 48 bits of entropy. Enough for a non-guessable public ID. */
function generateBundleId() {
    return crypto.randomBytes(6).toString('hex');
}

/** Default branding used as a starting point in the editor. */
function defaultBranding() {
    return {
        company_name: '',
        short_text: '',
        contact_email: '',
        contact_phone: '',
        contact_url: '',
        logo_data_url: '',
        primary_color: '#2563eb',
        accent_color: '#1e293b',
        background_color: '#0f172a',
        surface_color: '#1e293b',
        text_color: '#e2e8f0',
        text_muted_color: '#94a3b8',
        status_ready_color: '#22c55e',
        header_text_color: '#ffffff',
        allow_unattended: false,
        default_lang: 'en',
        server_host: '',
        use_https: conn.defaultUseHttps(),
        server: { address: '', api_url: '', public_key: '' },
    };
}

module.exports = {
    PLATFORMS,
    SUPPORTED_LANGS,
    validateBranding,
    hashBranding,
    generateBundleId,
    defaultBranding,
};
