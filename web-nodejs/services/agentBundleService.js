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
const config = require('../config/config');
const conn = require('./agentBundleConnection');

// Supported delivery targets. The portal renders one card per entry.
const PLATFORMS = [
    { platform: 'windows', arch: 'x64', format: 'portable',  label: 'Windows portable (.exe)' },
    { platform: 'windows', arch: 'x64', format: 'installed', label: 'Windows installed (.msi)' },
    { platform: 'linux',   arch: 'x64', format: 'portable',  label: 'Linux universal portable (.tar.gz)' },
    { platform: 'linux',   arch: 'x64', format: 'appimage',  label: 'Linux portable (AppImage)' },
    { platform: 'linux',   arch: 'x64', format: 'installed', label: 'Linux Debian/Ubuntu (.deb)' },
    { platform: 'linux',   arch: 'x64', format: 'rpm',       label: 'Linux Fedora/RHEL (.rpm)' },
];

const SUPPORTED_LANGS = [
    'ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hi', 'hu', 'id', 'it',
    'ja', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'sv', 'th', 'tr', 'uk', 'vi',
    'zh', 'zh-TW',
];

const LOCALE_LABELS = {
    ar: 'العربية',
    cs: 'Čeština',
    da: 'Dansk',
    de: 'Deutsch',
    en: 'English',
    es: 'Español',
    fi: 'Suomi',
    fr: 'Français',
    hi: 'हिन्दी',
    hu: 'Magyar',
    id: 'Bahasa Indonesia',
    it: 'Italiano',
    ja: '日本語',
    ko: '한국어',
    nb: 'Norsk Bokmål',
    nl: 'Nederlands',
    pl: 'Polski',
    pt: 'Português',
    ro: 'Română',
    sv: 'Svenska',
    th: 'ไทย',
    tr: 'Türkçe',
    uk: 'Українська',
    vi: 'Tiếng Việt',
    zh: '简体中文',
    'zh-TW': '繁體中文',
};
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Reasonable upper bounds: enough room for a base64 PNG/SVG logo (~10 MB),
// not enough to be a DoS vector.
const MAX_LOGO_BYTES = 10 * 1024 * 1024;  // 10 MB encoded
const MAX_SHORT_TEXT = 500;
const MAX_NAME       = 100;
const MAX_CONTACT    = 200;
const MAX_PRODUCT_LABEL = 200;

/** Portal-only fields — stored with branding JSON but excluded from build cache hash. */
const PORTAL_ONLY_BRANDING_KEYS = Object.freeze(['product_label', 'hide_product_type']);

/**
 * Optional white-label overrides for the public download portal product line.
 * Does not affect installer artifacts (omitted from hashBranding).
 */
function applyPortalProductFields(input, out) {
    out.product_label = clip(
        input.product_label || input.productLabel || '',
        MAX_PRODUCT_LABEL
    );
    out.hide_product_type = !!(input.hide_product_type ?? input.hideProductType ?? false);
}

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
    // Optional for quick Support Agent creation — defaults to product name.
    if (!out.company_name) {
        out.company_name = 'BetterDesk Support';
    }

    out.short_text   = clip(input.short_text   || input.shortText,   MAX_SHORT_TEXT);
    applyPortalProductFields(input, out);
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

    out.accent_color = (input.accent_color || input.accentColor || '#e0f2fe');
    if (!HEX_COLOR.test(out.accent_color)) {
        errors.push('accent_color_invalid');
        out.accent_color = '#e0f2fe';
    }
    out.accent_color = out.accent_color.toLowerCase();

    const colorFields = [
        ['background_color', '#ffffff', 'background_color'],
        ['surface_color', '#f3f4f6', 'surface_color'],
        ['text_color', '#1f2937', 'text_color'],
        ['text_muted_color', '#6b7280', 'text_muted_color'],
        ['status_ready_color', '#22c55e', 'status_ready_color'],
        ['header_text_color', '#1f2937', 'header_text_color'],
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

    // Incoming capability defaults (Support Agent). Omitted keys default to true.
    const capsIn = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : {};
    const cap = (v, d = true) => (v === undefined || v === null ? d : !!v);
    out.capabilities = {
        desktop:   cap(capsIn.desktop, true),
        files:     cap(capsIn.files, true),
        clipboard: cap(capsIn.clipboard, true),
        audio:     cap(capsIn.audio, true),
        terminal:  cap(capsIn.terminal, true),
        restart:   cap(capsIn.restart, true),
    };

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
    // HTTPS/WSS is recommended for public internet; HTTP/WS is allowed for
    // LAN/IP deployments (RustDesk-style). Session crypto stays on the
    // signal/relay protocol layer; the signed profile still binds endpoints.
    out.use_https = !!(input.use_https ?? input.useHttps ?? true);

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
 * Portal-only keys (product_label, hide_product_type) are omitted so changing
 * download-page copy does not invalidate installer builds.
 */
function hashBranding(normalized) {
    const forHash = { ...(normalized || {}) };
    for (const key of PORTAL_ONLY_BRANDING_KEYS) {
        delete forHash[key];
    }
    const json = stableStringify(forHash);
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

const MAX_SLUG_LENGTH = 32;
const MIN_SLUG_LENGTH = 2;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const TRANSLIT_MAP = {
    'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
    'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'å': 'a',
    'č': 'c', 'ď': 'd', 'ě': 'e', 'ň': 'n', 'ř': 'r', 'š': 's', 'ť': 't', 'ů': 'u', 'ý': 'y', 'ž': 'z',
};

function transliterate(input) {
    return String(input || '')
        .split('')
        .map(ch => TRANSLIT_MAP[ch] ?? TRANSLIT_MAP[ch.toLowerCase()] ?? ch)
        .join('');
}

/** Turn a human label into a URL-safe slug segment (may be empty). */
function slugifyName(name) {
    let slug = transliterate(String(name || '').trim().toLowerCase());
    slug = slug
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (slug.length > MAX_SLUG_LENGTH) {
        slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-$/, '');
    }
    return slug;
}

/** Normalize operator-provided slug input. */
function normalizeSlug(input) {
    return slugifyName(input);
}

function validateSlug(slug) {
    if (!slug || typeof slug !== 'string') {
        return { valid: false, error: 'slug_invalid' };
    }
    if (slug.length < MIN_SLUG_LENGTH) {
        return { valid: false, error: 'slug_too_short' };
    }
    if (slug.length > MAX_SLUG_LENGTH) {
        return { valid: false, error: 'slug_too_long' };
    }
    if (!SLUG_PATTERN.test(slug)) {
        return { valid: false, error: 'slug_invalid' };
    }
    return { valid: true };
}

/**
 * Pick a unique public slug. Uses `preferred`, then `name`, then `fallbackId`.
 * `isTaken(slug)` must return true when the slug is unavailable.
 */
function allocateUniqueSlug({ preferred, name, fallbackId, isTaken }) {
    const tryBase = (base) => {
        if (!base) return '';
        const normalized = normalizeSlug(base);
        return validateSlug(normalized).valid ? normalized : '';
    };

    let base = tryBase(preferred) || tryBase(name) || tryBase(fallbackId) || '';
    if (!base && fallbackId) {
        base = String(fallbackId).slice(0, MAX_SLUG_LENGTH);
    }
    if (!base) {
        base = generateBundleId();
    }

    let candidate = base;
    let suffix = 2;
    while (isTaken(candidate)) {
        const tail = `-${suffix}`;
        candidate = base.slice(0, Math.max(MIN_SLUG_LENGTH, MAX_SLUG_LENGTH - tail.length)) + tail;
        suffix += 1;
    }
    return candidate;
}

/** Public URL segment for a bundle row — slug when set, legacy hex id otherwise. */
function publicBundleId(row) {
    if (!row) return '';
    return row.slug || row.bundle_id || '';
}

/** Default branding used as a starting point in the editor. */
function defaultBranding() {
    return {
        company_name: '',
        short_text: '',
        product_label: '',
        hide_product_type: false,
        contact_email: '',
        contact_phone: '',
        contact_url: '',
        logo_data_url: '',
        primary_color: '#2563eb',
        accent_color: '#e0f2fe',
        background_color: '#ffffff',
        surface_color: '#f3f4f6',
        text_color: '#1f2937',
        text_muted_color: '#6b7280',
        status_ready_color: '#22c55e',
        header_text_color: '#1f2937',
        allow_unattended: false,
        capabilities: {
            desktop: true,
            files: true,
            clipboard: true,
            audio: true,
            terminal: true,
            restart: true,
        },
        default_lang: 'en',
        server_host: '',
        use_https: true,
        server: { address: '', api_url: '', public_key: '' },
    };
}

/**
 * Validate branding for RdClient desktop bundles (panel URL embedded in installer).
 */
function validateRdclientBranding(input = {}) {
    const errors = [];
    const out = {};

    out.company_name = clip(input.company_name || input.companyName || 'BetterDesk RdClient', MAX_NAME);
    applyPortalProductFields(input, out);
    out.server_host = clip(input.server_host || input.serverHost, 253);
    out.use_https = input.use_https !== false && input.useHttps !== false;

    const hostNorm = conn.normalizeServerHost(out.server_host);
    if (!hostNorm.valid) {
        errors.push(hostNorm.error || 'server_host_invalid');
    } else {
        out.server_host = hostNorm.host;
    }

    const scheme = out.use_https ? 'https' : 'http';
    const port = config.port;
    const omitPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    out.panel_url = omitPort
        ? `${scheme}://${out.server_host}`
        : `${scheme}://${out.server_host}:${port}`;

    out.default_lang = clip(input.default_lang || input.defaultLang || 'en', 10);
    if (!SUPPORTED_LANGS.includes(out.default_lang)) {
        out.default_lang = 'en';
    }

    return { valid: errors.length === 0, errors, normalized: out };
}

module.exports = {
    PLATFORMS,
    SUPPORTED_LANGS,
    LOCALE_LABELS,
    MAX_SLUG_LENGTH,
    MIN_SLUG_LENGTH,
    MAX_PRODUCT_LABEL,
    PORTAL_ONLY_BRANDING_KEYS,
    validateBranding,
    validateRdclientBranding,
    hashBranding,
    generateBundleId,
    slugifyName,
    normalizeSlug,
    validateSlug,
    allocateUniqueSlug,
    publicBundleId,
    defaultBranding,
};
