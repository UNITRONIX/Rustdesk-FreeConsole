/**
 * BetterDesk Console - Branding Service
 * Manages white-label branding configuration (name, logo, colors, favicon)
 * Stored in auth.db branding_config table
 */

const db = require('./database');
const fontService = require('./fontService');
const { stripUntilStable, stripTagName } = require('../lib/stripUntilStable');

// Dangerous SVG elements that can execute scripts or fetch external resources.
// Includes <style> (CSS @import/expression XSS vectors) and <use> (xlink:href external SVG inclusion).
const SVG_DANGEROUS_TAGS = /<\s*(script|foreignobject|iframe|embed|object|applet|animate|set|style|use|image)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SVG_DANGEROUS_TAGS_SELFCLOSING = /<\s*(script|foreignobject|iframe|embed|object|applet|style|use|image)\b[^>]*\/>/gi;

// Dangerous attributes that can execute JavaScript or trigger external fetches.
const SVG_DANGEROUS_ATTRS = /\s(on\w+|xlink:href\s*=\s*["']\s*(?:javascript|data|vbscript|file):)[^>]*/gi;
// Residual HTML injection tokens stripped in a final pass (obfuscated/nested tags).
const SVG_ON_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi;
// Strip javascript:/data:/vbscript: URLs in href / xlink:href.
const SVG_JAVASCRIPT_HREF = /\b(?:xlink:)?href\s*=\s*["']\s*(?:javascript|data|vbscript|file):[^"']*/gi;
// Strip CSS expression() and @import inside style attributes (legacy IE / SVG abuse).
const SVG_CSS_EXPRESSION = /\b(?:expression|@import|url\s*\(\s*["']?\s*(?:javascript|data|vbscript|file):)/gi;

/**
 * Sanitize SVG content to prevent XSS / SSRF attacks.
 * Removes script tags, event handlers, dangerous URL schemes, external references.
 * @param {string} svg - Raw SVG string
 * @returns {string} - Sanitized SVG string
 */
function sanitizeSvg(svg) {
    if (!svg || typeof svg !== 'string') return '';

    let sanitized = svg;

    // Strip XML processing instructions and DOCTYPE (entity expansion / external DTD).
    sanitized = sanitized.replace(/<\?[\s\S]*?\?>/g, '');
    sanitized = sanitized.replace(/<!DOCTYPE[\s\S]*?>/gi, '');

    // Remove dangerous elements (repeat until stable — multi-pass tag stripping).
    let prev;
    do {
        prev = sanitized;
        sanitized = sanitized.replace(SVG_DANGEROUS_TAGS, '');
        sanitized = sanitized.replace(SVG_DANGEROUS_TAGS_SELFCLOSING, '');
    } while (sanitized !== prev);

    // Remove event handler attributes & dangerous href schemes (repeat until stable).
    do {
        prev = sanitized;
        sanitized = sanitized.replace(SVG_DANGEROUS_ATTRS, '');
        sanitized = sanitized.replace(SVG_JAVASCRIPT_HREF, ' href="#"');
        sanitized = sanitized.replace(SVG_CSS_EXPRESSION, 'blocked-');
    } while (sanitized !== prev);

    sanitized = stripUntilStable(sanitized, [
        (s) => stripTagName(s, 'script'),
        (s) => stripTagName(s, 'style'),
        (s) => s.replace(SVG_ON_ATTR, ' '),
    ]);

    return sanitized;
}

/**
 * Validate a logo / favicon URL.
 * Accepts only:
 *   - https:// or http:// absolute URLs (parseable, hostname present)
 *   - same-origin relative paths starting with a single "/"  (rejects "//evil.com" protocol-relative)
 *   - empty string (clears the field)
 *
 * Rejects: javascript:, data:, vbscript:, file:, blob:, and protocol-relative ("//") URLs.
 *
 * @param {string} value
 * @returns {string|null} normalized URL or null if invalid
 */
function validateBrandingUrl(value) {
    if (value === undefined || value === null) return '';
    const trimmed = String(value).trim();
    if (trimmed === '') return '';

    // Reject protocol-relative ("//host/path") explicitly — bypass for the "/" relative check.
    if (trimmed.startsWith('//')) return null;

    // Relative path: must start with a single "/" and contain no scheme.
    if (trimmed.startsWith('/')) {
        // Disallow ".." path traversal hints.
        if (trimmed.includes('..')) return null;
        return trimmed;
    }

    // Absolute URL: must parse and be http(s).
    try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!u.hostname) return null;
        return u.toString();
    } catch (_) {
        return null;
    }
}

/**
 * Sanitize a free-form CSS color or gradient value used in generated stylesheets.
 * Allows only a safe character set so the value cannot break out of its CSS
 * declaration or inject additional rules. Strips characters that could be used
 * for CSS injection (`{`, `}`, `;`, `<`, `>`, `@`, backslash, quotes) and
 * neutralizes `expression(` / `javascript:` / `url(` patterns.
 * @param {string} value
 * @returns {string} sanitized value (may be empty)
 */
function sanitizeCssColorValue(value) {
    if (value === undefined || value === null) return '';
    let v = String(value).trim();
    if (v === '') return '';
    // Drop anything outside a conservative allowlist for colors/gradients.
    v = v.replace(/[^a-zA-Z0-9#%.,()\s/-]/g, '');
    // Defuse function-based CSS abuse even within the allowed charset.
    v = v.replace(/expression\s*\(/gi, '');
    v = v.replace(/url\s*\(/gi, '');
    return v.substring(0, 400);
}

/**
 * Build a CSS background shorthand value from a configured background spec.
 * @param {string} type  - 'color' | 'gradient' | 'image' | anything else => ''
 * @param {string} color
 * @param {string} gradient
 * @param {string} imageUrl - already validated via validateBrandingUrl
 * @returns {string} CSS background value or '' when nothing is configured
 */
function buildBackgroundValue(type, color, gradient, imageUrl) {
    switch (type) {
        case 'color':
            return sanitizeCssColorValue(color);
        case 'gradient':
            return sanitizeCssColorValue(gradient);
        case 'image': {
            const url = validateBrandingUrl(imageUrl);
            if (!url) return '';
            // Encode quotes/parens defensively even though validation already ran.
            const safe = url.replace(/["()\\]/g, encodeURIComponent);
            return `url("${safe}")`;
        }
        default:
            return '';
    }
}

function normalizeBackgroundSize(size) {
    switch (String(size || '').trim()) {
        case 'contain':
        case 'repeat':
        case 'center':
        case 'auto':
        case 'cover':
            return String(size).trim();
        default:
            return 'cover';
    }
}

function flattenAppearanceInput(input) {
    if (!input || typeof input !== 'object') return {};
    const flat = {};
    const source = input.appearance && typeof input.appearance === 'object' ? input.appearance : input;

    for (const [section, keys] of Object.entries(APPEARANCE_FLAT_MAP)) {
        const sectionData = source[section];
        if (!sectionData || typeof sectionData !== 'object') continue;
        for (const key of keys) {
            if (key in sectionData) flat[key] = sectionData[key];
        }
    }

    // Accept both the flat legacy shape and the v2 nested shape.
    for (const key of Object.keys(DEFAULT_BRANDING)) {
        if (key in input && key !== 'appearance') flat[key] = input[key];
    }

    if (source.palette && typeof source.palette === 'object') {
        if (source.palette.colors && typeof source.palette.colors === 'object') {
            flat.colors = source.palette.colors;
        }
        if (source.palette.semantic && typeof source.palette.semantic === 'object') {
            flat.colors = {
                ...(flat.colors || {}),
                ...Object.fromEntries(Object.entries(source.palette.semantic)
                    .map(([semanticKey, value]) => [SEMANTIC_COLOR_ALIASES[semanticKey], value])
                    .filter(([legacyKey]) => legacyKey))
            };
        }
    }

    flat.appearanceSchemaVersion = '2';
    if (flat.bgSize) flat.bgSize = normalizeBackgroundSize(flat.bgSize);
    if (flat.rdclientBgSize) flat.rdclientBgSize = normalizeBackgroundSize(flat.rdclientBgSize);
    return flat;
}

function backgroundSpecFromBranding(branding, prefix, defaultType = 'none') {
    const typeKey = `${prefix}BgType`;
    const colorKey = `${prefix}BgColor`;
    const gradientKey = `${prefix}BgGradient`;
    const imageKey = `${prefix}BgImageUrl`;
    const overlayKey = `${prefix}BgOverlay`;
    const sizeKey = `${prefix}BgSize`;
    return {
        type: branding[typeKey] || defaultType,
        color: branding[colorKey] || '',
        gradient: branding[gradientKey] || '',
        imageUrl: branding[imageKey] || '',
        overlay: branding[overlayKey] || '',
        size: normalizeBackgroundSize(branding[sizeKey] || 'cover')
    };
}

function getAppearanceModel(brandingInput = null) {
    const branding = brandingInput || getBranding();
    const semantic = {};
    for (const [semanticKey, legacyKey] of Object.entries(SEMANTIC_COLOR_ALIASES)) {
        semantic[semanticKey] = branding.colors?.[legacyKey] || '';
    }
    return {
        version: '2.0',
        type: 'betterdesk-appearance',
        revision: getBrandingRevision(),
        identity: {
            appName: branding.appName,
            appDescription: branding.appDescription,
            logoType: branding.logoType,
            logoIcon: branding.logoIcon,
            logoSvg: branding.logoSvg,
            logoUrl: branding.logoUrl,
            logoText: branding.logoText,
            logoTextAccent: branding.logoTextAccent,
            faviconSvg: branding.faviconSvg
        },
        typography: {
            fontHeading: branding.fontHeading,
            fontBody: branding.fontBody
        },
        palette: {
            mode: branding.themeMode || 'dark',
            colors: { ...(branding.colors || {}) },
            semantic
        },
        backgrounds: {
            console: {
                type: branding.bgType || 'none',
                color: branding.bgColor || '',
                gradient: branding.bgGradient || '',
                imageUrl: branding.bgImageUrl || '',
                blur: branding.bgBlur || '',
                overlay: branding.bgOverlay || '',
                size: normalizeBackgroundSize(branding.bgSize || 'cover')
            },
            login: backgroundSpecFromBranding(branding, 'login', 'inherit'),
            agent: backgroundSpecFromBranding(branding, 'agent', 'none'),
            rdclient: backgroundSpecFromBranding(branding, 'rdclient', 'inherit')
        },
        surfaces: {
            glassEnabled: branding.glassEnabled !== 'false',
            glassColor: branding.glassColor,
            glassBlur: branding.glassBlur,
            glassOpacity: branding.glassOpacity
        },
        login: {
            title: branding.loginTitle,
            subtitle: branding.loginSubtitle
        },
        footer: {
            text: branding.footerText,
            showPoweredBy: branding.showPoweredBy !== 'false',
            agentShowPoweredBy: branding.agentShowPoweredBy !== 'false'
        },
        advanced: {
            customCssEnabled: !!(branding.customCss && branding.customCss.trim())
        }
    };
}

/**
 * Sanitize operator-supplied custom CSS (advanced escape hatch).
 * Removes constructs that could lead to XSS / data exfiltration:
 *   - </style> breakouts, HTML tags
 *   - @import (external stylesheet loading)
 *   - expression() (legacy IE script execution)
 *   - behavior: / -moz-binding: (HTC / XBL script binding)
 *   - url(javascript:|data:|vbscript:) schemes
 * @param {string} value
 * @returns {string} sanitized CSS (capped length)
 */
function sanitizeCustomCss(value) {
    if (value === undefined || value === null) return '';
    let css = String(value);
    css = stripUntilStable(css, [
        (s) => s.replace(/<\s*\/?\s*style[^>]*>/gi, ''),
        (s) => s.replace(/<[^>]*>/g, ''),
        (s) => stripTagName(s, 'script'),
        (s) => stripTagName(s, 'style'),
        (s) => s.replace(SVG_ON_ATTR, ' '),
    ]);
    css = css.replace(/@import\b[^;]*;?/gi, '');          // external imports
    css = css.replace(/expression\s*\(/gi, '');           // IE expression()
    css = css.replace(/(?:-\w+-)?behavior\s*:/gi, '');    // HTC/XBL binding
    css = css.replace(/-moz-binding\s*:/gi, '');          // Firefox XBL binding
    css = css.replace(/url\s*\(\s*["']?\s*(?:javascript|data|vbscript|file):[^)]*\)/gi, 'none');
    return css.substring(0, 20000);
}

// Default branding (BetterDesk original theme)
const DEFAULT_BRANDING = {
    // Brand identity
    appName: 'BetterDesk',
    appDescription: 'BetterDesk Server Management',
    
    // Logo configuration
    logoType: 'image', // 'icon' | 'svg' | 'image' | 'text'
    logoIcon: 'dns',   // Material Icons name (when logoType === 'icon')
    logoSvg: '',       // Raw SVG markup or SVG path data (when logoType === 'svg')
    logoUrl: '/img/betterdesk_icon.png', // URL to image file (when logoType === 'image')
    logoText: '',      // Text to display as logo (when logoType === 'text')
    logoTextAccent: '', // Accent text (different color, e.g. product name after brand)
    
    // Typography (Google Fonts)
    fontHeading: '',   // Font family for headings / logo text (empty = system default)
    fontBody: '',      // Font family for body text (empty = system default)
    
    // Favicon (SVG)
    faviconSvg: '',   // Custom favicon SVG (empty = default)

    // Console background & appearance
    bgType: 'none',     // 'none' | 'color' | 'gradient' | 'image'
    bgColor: '',        // solid color (when bgType === 'color')
    bgGradient: '',     // CSS gradient (when bgType === 'gradient')
    bgImageUrl: '',     // uploaded/linked image (when bgType === 'image')
    bgBlur: '',         // blur radius in px applied to the wallpaper layer
    bgOverlay: '',      // dark overlay opacity 0-100 (%) for readability
    bgSize: 'cover',    // 'cover' | 'contain' | 'repeat' | 'center'

    // Glass surfaces (cards, modals, forms, navbar, etc.)
    glassEnabled: 'true',   // 'true' | 'false'
    glassColor: '#161b22',  // tint color (hex); empty = use bgSecondary
    glassBlur: '16',        // backdrop-filter blur px (0-40)
    glassOpacity: '55',     // tint opacity 0-100 (%)

    // Login page branding
    loginBgType: 'inherit', // 'inherit' | 'none' | 'color' | 'gradient' | 'image'
    loginBgColor: '',
    loginBgGradient: '',
    loginBgImageUrl: '',
    loginBgOverlay: '',     // dark overlay opacity 0-100 (%)
    loginTitle: '',         // overrides the login heading
    loginSubtitle: '',      // overrides the login subtitle

    // Footer / attribution
    footerText: '',         // custom footer / copyright text
    showPoweredBy: 'true',  // 'true' | 'false' — show "Powered by BetterDesk"

    // Agent download portal (global defaults shared by all bundles)
    agentBgType: 'none',    // 'none' | 'color' | 'gradient' | 'image'
    agentBgColor: '',
    agentBgGradient: '',
    agentBgImageUrl: '',
    agentShowPoweredBy: 'true', // 'true' | 'false'

    // Advanced — custom CSS escape hatch (sanitized)
    customCss: '',

    // Appearance model metadata (v2 keeps flat keys for backward compatibility)
    appearanceSchemaVersion: '2',
    themeMode: 'dark',       // 'dark' | 'light' | 'custom' (auto kept for backward compat → dark)

    // Color scheme overrides (empty = use defaults from variables.css)
    colors: {
        bgPrimary: '',
        bgSecondary: '',
        bgTertiary: '',
        bgElevated: '',
        textPrimary: '',
        textSecondary: '',
        accentBlue: '',
        accentBlueHover: '',
        accentBlueMuted: '',
        accentGreen: '',
        accentGreenHover: '',
        accentGreenMuted: '',
        accentRed: '',
        accentRedHover: '',
        accentRedMuted: '',
        accentYellow: '',
        accentYellowHover: '',
        accentYellowMuted: '',
        accentPurple: '',
        accentPurpleHover: '',
        accentPurpleMuted: '',
        borderPrimary: '',
        borderSecondary: ''
    },

    // RdClient / remote dashboard background. The desktop shell loads /remote
    // from the panel, so this controls the web content used by Tauri as well.
    rdclientBgType: 'inherit', // 'inherit' | 'none' | 'color' | 'gradient' | 'image'
    rdclientBgColor: '',
    rdclientBgGradient: '',
    rdclientBgImageUrl: '',
    rdclientBgOverlay: '',
    rdclientBgSize: 'cover'
};

/** Built-in palettes for themeMode light/dark (custom uses branding.colors). */
const BUILTIN_THEME_PALETTES = {
    dark: {
        bgPrimary: '#0d1117',
        bgSecondary: '#161b22',
        bgTertiary: '#21262d',
        bgElevated: '#30363d',
        textPrimary: '#e6edf3',
        textSecondary: '#8b949e',
        accentBlue: '#58a6ff',
        accentBlueHover: '#79c0ff',
        accentBlueMuted: '#58a6ff',
        accentGreen: '#2ea44f',
        accentGreenHover: '#3fb950',
        accentGreenMuted: '#2ea44f',
        accentRed: '#f85149',
        accentRedHover: '#ff6b6b',
        accentRedMuted: '#f85149',
        accentYellow: '#d29922',
        accentYellowHover: '#e3b341',
        accentYellowMuted: '#d29922',
        accentPurple: '#a371f7',
        accentPurpleHover: '#bc8cff',
        accentPurpleMuted: '#a371f7',
        borderPrimary: '#30363d',
        borderSecondary: '#21262d'
    },
    light: {
        bgPrimary: '#f0f2f5',
        bgSecondary: '#ffffff',
        bgTertiary: '#eaeef2',
        bgElevated: '#ffffff',
        textPrimary: '#1f2328',
        textSecondary: '#656d76',
        accentBlue: '#0969da',
        accentBlueHover: '#0550ae',
        accentBlueMuted: '#0969da',
        accentGreen: '#1a7f37',
        accentGreenHover: '#116329',
        accentGreenMuted: '#1a7f37',
        accentRed: '#cf222e',
        accentRedHover: '#a40e26',
        accentRedMuted: '#cf222e',
        accentYellow: '#9a6700',
        accentYellowHover: '#7d4e00',
        accentYellowMuted: '#9a6700',
        accentPurple: '#8250df',
        accentPurpleHover: '#6639ba',
        accentPurpleMuted: '#8250df',
        borderPrimary: '#d0d7de',
        borderSecondary: '#eaeef2'
    }
};

function normalizeThemeMode(mode) {
    let m = String(mode || 'dark');
    if (m === 'auto') m = 'dark';
    if (!['dark', 'light', 'custom'].includes(m)) m = 'dark';
    return m;
}

/**
 * Resolve effective color map for CSS generation.
 * light/dark ignore stale DB custom colors so themeMode always matches the UI.
 */
function resolveThemeColors(branding) {
    const mode = normalizeThemeMode(branding && branding.themeMode);
    if (mode === 'light' || mode === 'dark') {
        return { ...BUILTIN_THEME_PALETTES[mode] };
    }
    const stored = (branding && branding.colors) || {};
    const merged = { ...BUILTIN_THEME_PALETTES.dark };
    for (const [key, value] of Object.entries(stored)) {
        if (value && String(value).trim()) merged[key] = String(value).trim();
    }
    return merged;
}

// CSS variable name mapping
const COLOR_TO_CSS_VAR = {
    bgPrimary: '--bg-primary',
    bgSecondary: '--bg-secondary',
    bgTertiary: '--bg-tertiary',
    bgElevated: '--bg-elevated',
    textPrimary: '--text-primary',
    textSecondary: '--text-secondary',
    accentBlue: '--accent-blue',
    accentBlueHover: '--accent-blue-hover',
    accentBlueMuted: '--accent-blue-muted',
    accentGreen: '--accent-green',
    accentGreenHover: '--accent-green-hover',
    accentGreenMuted: '--accent-green-muted',
    accentRed: '--accent-red',
    accentRedHover: '--accent-red-hover',
    accentRedMuted: '--accent-red-muted',
    accentYellow: '--accent-yellow',
    accentYellowHover: '--accent-yellow-hover',
    accentYellowMuted: '--accent-yellow-muted',
    accentPurple: '--accent-purple',
    accentPurpleHover: '--accent-purple-hover',
    accentPurpleMuted: '--accent-purple-muted',
    borderPrimary: '--border-primary',
    borderSecondary: '--border-secondary'
};

const SEMANTIC_COLOR_ALIASES = {
    primary: 'accentBlue',
    primaryHover: 'accentBlueHover',
    primaryMuted: 'accentBlueMuted',
    success: 'accentGreen',
    successHover: 'accentGreenHover',
    successMuted: 'accentGreenMuted',
    danger: 'accentRed',
    dangerHover: 'accentRedHover',
    dangerMuted: 'accentRedMuted',
    warning: 'accentYellow',
    warningHover: 'accentYellowHover',
    warningMuted: 'accentYellowMuted',
    info: 'accentPurple',
    infoHover: 'accentPurpleHover',
    infoMuted: 'accentPurpleMuted',
    surface: 'bgSecondary',
    surfaceRaised: 'bgTertiary',
    surfaceElevated: 'bgElevated',
    textPrimary: 'textPrimary',
    textMuted: 'textSecondary',
    border: 'borderPrimary'
};

const APPEARANCE_FLAT_MAP = {
    identity: ['appName', 'appDescription', 'logoType', 'logoIcon', 'logoSvg', 'logoUrl', 'logoText', 'logoTextAccent', 'faviconSvg'],
    typography: ['fontHeading', 'fontBody'],
    palette: ['themeMode', 'colors'],
    console: ['bgType', 'bgColor', 'bgGradient', 'bgImageUrl', 'bgBlur', 'bgOverlay', 'bgSize'],
    surfaces: ['glassEnabled', 'glassColor', 'glassBlur', 'glassOpacity'],
    login: ['loginBgType', 'loginBgColor', 'loginBgGradient', 'loginBgImageUrl', 'loginBgOverlay', 'loginTitle', 'loginSubtitle'],
    agent: ['agentBgType', 'agentBgColor', 'agentBgGradient', 'agentBgImageUrl', 'agentShowPoweredBy'],
    rdclient: ['rdclientBgType', 'rdclientBgColor', 'rdclientBgGradient', 'rdclientBgImageUrl', 'rdclientBgOverlay', 'rdclientBgSize'],
    footer: ['footerText', 'showPoweredBy'],
    advanced: ['customCss']
};

// In-memory cache
let brandingCache = null;
let brandingRevision = '0';

/**
 * Bump cache-bust token after branding mutations.
 */
function bumpBrandingRevision() {
    brandingRevision = Date.now().toString(36);
}

/**
 * Revision string for branding.css cache busting (EJS + autosave).
 * @returns {string}
 */
function getBrandingRevision() {
    return brandingRevision;
}

/**
 * Load branding configuration from database into cache (async).
 * Must be called once at startup before any request is served.
 * @returns {Promise<Object>} Merged branding config
 */
async function loadBranding() {
    try {
        const rows = await db.getBrandingConfig();

        // Start with defaults
        const branding = JSON.parse(JSON.stringify(DEFAULT_BRANDING));

        for (const row of rows) {
            if (row.key === 'colors') {
                try {
                    const savedColors = JSON.parse(row.value);
                    Object.assign(branding.colors, savedColors);
                } catch (e) {
                    // Ignore invalid JSON
                }
            } else if (row.key in branding) {
                branding[row.key] = row.value;
            }
        }

        brandingCache = branding;
        try {
            const rev = await db.getBrandingConfigRevision();
            brandingRevision = rev ? String(rev).replace(/[^a-zA-Z0-9._-]/g, '') : Date.now().toString(36);
        } catch (_) {
            bumpBrandingRevision();
        }
        return branding;
    } catch (err) {
        console.error('[Branding] Failed to load from DB, using defaults:', err.message);
        brandingCache = JSON.parse(JSON.stringify(DEFAULT_BRANDING));
        bumpBrandingRevision();
        return brandingCache;
    }
}

/**
 * Get branding configuration (synchronous, from cache).
 * Returns defaults if cache has not been warmed yet.
 * @returns {Object} Merged branding config (defaults + overrides)
 */
function getBranding() {
    if (brandingCache) return brandingCache;
    // Cache not yet loaded — return defaults (startup race condition safety)
    return JSON.parse(JSON.stringify(DEFAULT_BRANDING));
}

/**
 * Save branding configuration (async — uses database adapter)
 * @param {Object} updates - Partial branding config to save
 */
async function saveBranding(updates) {
    const entries = [];
    const normalizedUpdates = flattenAppearanceInput(updates);
    for (const [key, value] of Object.entries(normalizedUpdates)) {
        if (key === 'colors') {
            const sanitizedColors = {};
            for (const colorKey of Object.keys(DEFAULT_BRANDING.colors)) {
                if (value && Object.prototype.hasOwnProperty.call(value, colorKey)) {
                    sanitizedColors[colorKey] = sanitizeCssColorValue(value[colorKey]).substring(0, 100);
                }
            }
            entries.push({ key, value: JSON.stringify(sanitizedColors) });
        } else if (key in DEFAULT_BRANDING) {
            // Security: Sanitize SVG content to prevent XSS
            if (key === 'logoSvg' || key === 'faviconSvg') {
                entries.push({ key, value: sanitizeSvg(String(value)) });            } else if (key === 'logoUrl' || key === 'faviconUrl' ||
                       key === 'bgImageUrl' || key === 'loginBgImageUrl' || key === 'agentBgImageUrl' ||
                       key === 'rdclientBgImageUrl') {
                // Security: Validate URL scheme to prevent javascript:/data:/file:/protocol-relative XSS/SSRF.
                const normalized = validateBrandingUrl(value);
                if (normalized === null) continue; // skip invalid value, keep previous DB value
                entries.push({ key, value: normalized });
            } else if (key === 'bgColor' || key === 'bgGradient' ||
                       key === 'loginBgColor' || key === 'loginBgGradient' ||
                       key === 'agentBgColor' || key === 'agentBgGradient' ||
                       key === 'rdclientBgColor' || key === 'rdclientBgGradient' ||
                       key === 'glassColor') {
                // Security: Restrict to a safe CSS color/gradient charset.
                entries.push({ key, value: sanitizeCssColorValue(value) });
            } else if (key === 'bgSize' || key === 'rdclientBgSize') {
                entries.push({ key, value: normalizeBackgroundSize(value) });
            } else if (key === 'themeMode') {
                entries.push({ key, value: normalizeThemeMode(value) });
            } else if (key === 'customCss') {
                // Security: Neutralize CSS-based XSS / external resource loading.
                entries.push({ key, value: sanitizeCustomCss(value) });
            } else {
                entries.push({ key, value: String(value) });
            }
        }
    }

    if (entries.length > 0) {
        await db.saveBrandingConfigBatch(entries);
    }

    // Reload cache from DB
    await loadBranding();
}

/**
 * Reset branding to defaults (async — uses database adapter)
 */
async function resetBranding() {
    await db.resetBrandingConfig();
    brandingCache = null;
    await loadBranding();
}

// ==================== Branding Profiles ====================

/**
 * List saved branding profiles (metadata only).
 * @returns {Promise<Array>}
 */
async function listProfiles() {
    return db.listBrandingProfiles();
}

/**
 * Create a profile snapshot from branding data.
 * @param {string} name
 * @param {string} [description]
 * @param {Object} [brandingData] - defaults to current branding export
 * @returns {Promise<number>} profile id
 */
async function createProfile(name, description = '', brandingData = null) {
    const trimmed = String(name || '').trim().substring(0, 80);
    if (!trimmed) throw new Error('Profile name is required');
    const preset = brandingData && brandingData.type === 'betterdesk-theme'
        ? brandingData
        : exportPreset();
    return db.createBrandingProfile(trimmed, String(description || '').substring(0, 200), preset);
}

/**
 * Update profile data from current or supplied branding.
 * @param {number} id
 * @param {Object} updates - { name?, description?, branding? }
 */
async function updateProfile(id, updates = {}) {
    const profile = await db.getBrandingProfile(id);
    if (!profile) throw new Error('Profile not found');
    const name = updates.name != null ? String(updates.name).trim().substring(0, 80) : profile.name;
    const description = updates.description != null
        ? String(updates.description).substring(0, 200)
        : (profile.description || '');
    const data = updates.branding
        ? { version: '1.0', type: 'betterdesk-theme', branding: updates.branding }
        : JSON.parse(profile.data);
    await db.updateBrandingProfile(id, name, description, data);
}

/**
 * Apply a saved profile to active branding_config.
 * @param {number} id
 */
async function applyProfile(id) {
    const profile = await db.getBrandingProfile(id);
    if (!profile) return false;
    let preset;
    try {
        preset = JSON.parse(profile.data);
    } catch (_) {
        return false;
    }
    const ok = await importPreset(preset);
    if (!ok) return false;
    await db.setActiveBrandingProfile(id);
    return true;
}

/**
 * Delete a branding profile (not allowed for active profile).
 * @param {number} id
 */
async function deleteProfile(id) {
    const profile = await db.getBrandingProfile(id);
    if (!profile) return false;
    if (profile.is_active) throw new Error('Cannot delete the active profile');
    await db.deleteBrandingProfile(id);
    return true;
}

/**
 * Duplicate an existing profile.
 * @param {number} id
 * @param {string} [newName]
 */
async function duplicateProfile(id, newName = '') {
    const profile = await db.getBrandingProfile(id);
    if (!profile) throw new Error('Profile not found');
    const baseName = newName.trim() || `${profile.name} (copy)`;
    let name = baseName.substring(0, 80);
    const existing = await db.listBrandingProfiles();
    let suffix = 2;
    while (existing.some(p => p.name === name)) {
        name = `${baseName.substring(0, 70)} ${suffix}`;
        suffix += 1;
    }
    let data;
    try {
        data = JSON.parse(profile.data);
    } catch (_) {
        data = exportPreset();
    }
    return db.createBrandingProfile(name, profile.description || '', data);
}

function generateSemanticAliasCss(branding) {
    const lines = [
        '    --color-primary: var(--accent-blue);',
        '    --color-primary-hover: var(--accent-blue-hover);',
        '    --color-primary-muted: var(--accent-blue-muted);',
        '    --color-success: var(--accent-green);',
        '    --color-success-hover: var(--accent-green-hover);',
        '    --color-success-muted: var(--accent-green-muted);',
        '    --color-danger: var(--accent-red);',
        '    --color-danger-hover: var(--accent-red-hover);',
        '    --color-danger-muted: var(--accent-red-muted);',
        '    --color-warning: var(--accent-yellow);',
        '    --color-warning-hover: var(--accent-yellow-hover);',
        '    --color-warning-muted: var(--accent-yellow-muted);',
        '    --color-info: var(--accent-purple);',
        '    --color-info-hover: var(--accent-purple-hover);',
        '    --color-info-muted: var(--accent-purple-muted);',
        '    --color-surface: var(--bg-secondary);',
        '    --color-surface-alt: var(--bg-primary);',
        '    --color-surface-hover: var(--bg-tertiary);',
        '    --color-surface-raised: var(--bg-elevated);',
        '    --color-text: var(--text-primary);',
        '    --color-text-muted: var(--text-secondary);',
        '    --color-border: var(--border-primary);',
        '    --focus-ring-color: var(--accent-blue-muted);',
        `    color-scheme: ${normalizeThemeMode(branding.themeMode) === 'light' ? 'light' : 'dark'};`,
        '    /* UX 3.5 chrome aliases — solid surfaces (no glass/blur in this shell) */',
        '    --ux35-bg: var(--bg-primary);',
        '    --ux35-sidebar-bg: var(--bg-secondary);',
        '    --ux35-card-bg: var(--bg-secondary);',
        '    --ux35-border: var(--border-primary);',
        '    --ux35-border-light: var(--border-secondary);',
        '    --ux35-text: var(--text-primary);',
        '    --ux35-muted: var(--text-secondary);',
        '    --ux35-hover: var(--bg-hover);',
        '    --ux35-primary: var(--accent-blue);',
        '    --ux35-active-bg: var(--accent-blue-muted);',
        '    --ux35-glass-blur: 0px;',
        '    --ux35-glass-saturate: 1;'
    ];
    const mode = normalizeThemeMode(branding.themeMode);
    if (mode === 'light') {
        lines.push('    --ux35-topbar-bg: var(--accent-blue);');
        lines.push('    --ux35-topbar-fg: #ffffff;');
        lines.push('    --ux35-topbar-fg-muted: rgba(255, 255, 255, 0.78);');
    } else {
        lines.push('    --ux35-topbar-bg: var(--bg-elevated, var(--bg-secondary));');
        lines.push('    --ux35-topbar-fg: var(--text-primary);');
        lines.push('    --ux35-topbar-fg-muted: var(--text-secondary);');
    }
    return `:root {\n${lines.join('\n')}\n}\n`;
}

/**
 * Generate CSS :root overrides from branding colors and fonts
 * @returns {string} CSS string with @font-face imports and :root variable overrides
 */
function generateThemeCss() {
    const branding = getBranding();
    const themeMode = normalizeThemeMode(branding.themeMode);
    const colors = resolveThemeColors(branding);
    const overrides = [];

    for (const [key, cssVar] of Object.entries(COLOR_TO_CSS_VAR)) {
        const value = colors[key];
        if (value && String(value).trim()) {
            // For muted colors, auto-generate rgba if a hex color is provided
            if (key.endsWith('Muted') && String(value).startsWith('#')) {
                const hex = String(value).replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);
                overrides.push(`    ${cssVar}: rgba(${r}, ${g}, ${b}, 0.15);`);
            } else {
                overrides.push(`    ${cssVar}: ${value};`);
            }
        }
    }

    let css = '';

    // Font CSS (imports + heading/body font variables)
    const fontCss = fontService.generateFontCss(branding.fontHeading, branding.fontBody);
    if (fontCss) {
        css += fontCss + '\n';
    }

    // Color overrides — always emit effective palette for the active themeMode
    if (overrides.length > 0) {
        css += `:root {\n${overrides.join('\n')}\n}\n`;
    }

    // Keep data-theme attribute in sync for component selectors (ui-polish / theme.css)
    css += `html { color-scheme: ${themeMode === 'light' ? 'light' : 'dark'}; }\n`;

    // Semantic aliases consumed by newer UI and legacy components that use
    // --color-* names instead of the original BetterDesk token names.
    css += generateSemanticAliasCss({ ...branding, themeMode, colors });

    // Glass surface tokens (light mode uses light glass base when unset)
    css += generateGlassCss({ ...branding, themeMode, colors });

    // Background wallpaper (console + login) and custom CSS
    css += generateBackgroundCss(branding);

    const customCss = sanitizeCustomCss(branding.customCss);
    if (customCss.trim()) {
        css += `\n/* --- custom branding CSS --- */\n${customCss}\n`;
    }

    return css;
}

/** Clamp a numeric branding input (blur px / overlay %) to a safe range. */
function clampNumber(value, min, max) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
}

/** Parse a 6-digit hex color into RGB components. */
function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16)
    };
}

/**
 * Generate CSS variables for frosted-glass panel surfaces.
 * @param {Object} branding
 * @returns {string}
 */
function generateGlassCss(branding) {
    const enabled = branding.glassEnabled !== 'false';
    if (!enabled) {
        return `:root {
    --surface-glass-blur: 0px;
    --surface-glass-saturate: 1;
    --surface-glass-bg-secondary: var(--bg-secondary);
    --surface-glass-bg-tertiary: var(--bg-tertiary);
    --surface-glass-bg-elevated: var(--bg-elevated);
    --surface-glass-border: var(--border-primary);
    --card-bg: var(--bg-secondary);
    --sidebar-glass-bg-rail: var(--sidebar-rail-bg);
    --sidebar-glass-bg-flyout: var(--sidebar-flyout-bg);
}\n`;
    }

    const blur = clampNumber(branding.glassBlur, 0, 40) ?? 16;
    const opacity = (clampNumber(branding.glassOpacity, 0, 100) ?? 55) / 100;
    let color = (branding.glassColor || '').trim();
    const mode = normalizeThemeMode(branding.themeMode);
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        const fromColors = branding.colors && branding.colors.bgSecondary;
        if (/^#[0-9a-fA-F]{6}$/.test(fromColors || '')) {
            color = fromColors;
        } else {
            color = mode === 'light' ? '#ffffff' : '#161b22';
        }
    }
    const rgb = hexToRgb(color);
    if (!rgb) return '';

    const tertiaryAlpha = Math.min(1, opacity + 0.08).toFixed(2);
    const elevatedAlpha = Math.min(1, opacity + 0.15).toFixed(2);
    const borderAlpha = Math.min(1, opacity + 0.35).toFixed(2);
    const railAlpha = Math.max(0.32, Math.min(0.78, opacity - 0.07)).toFixed(2);
    const flyoutAlpha = Math.max(0.42, Math.min(0.84, opacity + 0.03)).toFixed(2);

    return `:root {
    --surface-glass-blur: ${blur}px;
    --surface-glass-saturate: 1.2;
    --surface-glass-bg-secondary: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity.toFixed(2)});
    --surface-glass-bg-tertiary: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${tertiaryAlpha});
    --surface-glass-bg-elevated: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${elevatedAlpha});
    --surface-glass-border: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${borderAlpha});
    --card-bg: var(--surface-glass-bg-secondary);
    --sidebar-glass-bg-rail: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${railAlpha});
    --sidebar-glass-bg-flyout: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${flyoutAlpha});
}\n`;
}

/**
 * Generate the wallpaper / overlay CSS for the console (.app-page) and the
 * login page (.login-page). The wallpaper sits on a fixed pseudo-element behind
 * all content; the scrollable content area is made transparent so cards float
 * over it. Login background can either inherit the console one or override it.
 * @param {Object} branding
 * @returns {string}
 */
function generateBackgroundCss(branding) {
    let out = '';

    const sizeRule = (size) => {
        switch (size) {
            case 'contain': return 'background-size: contain; background-repeat: no-repeat; background-position: center;';
            case 'repeat':  return 'background-repeat: repeat;';
            case 'auto':    return 'background-size: auto; background-repeat: no-repeat; background-position: center;';
            case 'center':  return 'background-size: auto; background-repeat: no-repeat; background-position: center;';
            case 'cover':
            default:        return 'background-size: cover; background-repeat: no-repeat; background-position: center;';
        }
    };

    // ---- Console wallpaper ----
    const consoleBg = buildBackgroundValue(branding.bgType, branding.bgColor, branding.bgGradient, branding.bgImageUrl);
    if (consoleBg) {
        const blur = clampNumber(branding.bgBlur, 0, 40);
        const overlay = clampNumber(branding.bgOverlay, 0, 95);
        out += `body.app-page::before {\n` +
               `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: 0;\n    pointer-events: none;\n` +
               `    background: ${consoleBg};\n    ${branding.bgType === 'image' ? sizeRule(branding.bgSize) : ''}\n` +
               (blur ? `    filter: blur(${blur}px);\n    transform: scale(1.05);\n` : '') +
               `}\n`;
        if (overlay) {
            out += `body.app-page::after {\n` +
                   `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: 0;\n` +
                   `    background: rgba(0, 0, 0, ${(overlay / 100).toFixed(2)});\n    pointer-events: none;\n}\n`;
        }
        // Let the wallpaper show behind floating cards in the content area.
        out += `body.app-page { background-color: transparent; position: relative; isolation: isolate; }\n`;
        out += `body.app-page .app-layout,\nbody.app-page .ux35-shell,\nbody.app-page #desktop-shell,\nbody.app-page #modal-container,\nbody.app-page #toast-container { position: relative; z-index: 1; }\n`;
        out += `body.app-page .main-wrapper,\nbody.app-page .app-layout,\nbody.app-page .ux35-shell { background: transparent; }\n`;
        out += `body.app-page .main-content,\nbody.app-page .ux35-content { background: transparent; }\n`;
    }

    // ---- Login wallpaper ----
    let loginBg = '';
    let loginOverlay = null;
    if (branding.loginBgType === 'inherit') {
        loginBg = consoleBg;
        loginOverlay = clampNumber(branding.bgOverlay, 0, 95);
    } else if (branding.loginBgType && branding.loginBgType !== 'none') {
        loginBg = buildBackgroundValue(branding.loginBgType, branding.loginBgColor, branding.loginBgGradient, branding.loginBgImageUrl);
        loginOverlay = clampNumber(branding.loginBgOverlay, 0, 95);
    }
    if (loginBg) {
        out += `body.login-page::before {\n` +
               `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: -2;\n` +
               `    background: ${loginBg};\n    background-size: cover;\n    background-position: center;\n    background-repeat: no-repeat;\n}\n`;
        if (loginOverlay) {
            out += `body.login-page::after {\n` +
                   `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: -1;\n` +
                   `    background: rgba(0, 0, 0, ${(loginOverlay / 100).toFixed(2)});\n    pointer-events: none;\n}\n`;
        }
        out += `body.login-page { background-color: transparent; }\n`;
    }

    // ---- RdClient / remote dashboard wallpaper ----
    let rdclientBg = '';
    let rdclientOverlay = null;
    let rdclientType = branding.rdclientBgType || 'inherit';
    if (rdclientType === 'inherit') {
        rdclientBg = consoleBg;
        rdclientType = branding.bgType;
        rdclientOverlay = clampNumber(branding.bgOverlay, 0, 95);
    } else if (rdclientType && rdclientType !== 'none') {
        rdclientBg = buildBackgroundValue(
            rdclientType,
            branding.rdclientBgColor,
            branding.rdclientBgGradient,
            branding.rdclientBgImageUrl
        );
        rdclientOverlay = clampNumber(branding.rdclientBgOverlay, 0, 95);
    }
    if (rdclientBg) {
        out += `body.rd-desk-body::before {\n` +
               `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: 0;\n    pointer-events: none;\n` +
               `    background: ${rdclientBg};\n    ${rdclientType === 'image' ? sizeRule(branding.rdclientBgSize || branding.bgSize) : ''}\n}\n`;
        if (rdclientOverlay) {
            out += `body.rd-desk-body::after {\n` +
                   `    content: '';\n    position: fixed;\n    inset: 0;\n    z-index: 0;\n` +
                   `    background: rgba(0, 0, 0, ${(rdclientOverlay / 100).toFixed(2)});\n    pointer-events: none;\n}\n`;
        }
        out += `body.rd-desk-body { background-color: transparent; position: relative; isolation: isolate; }\n`;
        out += `body.rd-desk-body .rd-desk-app { position: relative; z-index: 1; }\n`;
    }

    return out;
}

function luminanceComponent(value) {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function contrastRatio(hexA, hexB) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    if (!a || !b) return null;
    const lumA = 0.2126 * luminanceComponent(a.r) + 0.7152 * luminanceComponent(a.g) + 0.0722 * luminanceComponent(a.b);
    const lumB = 0.2126 * luminanceComponent(b.r) + 0.7152 * luminanceComponent(b.g) + 0.0722 * luminanceComponent(b.b);
    const lighter = Math.max(lumA, lumB);
    const darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
}

function assessAppearanceReadability(brandingInput = null) {
    const branding = brandingInput || getBranding();
    const colors = { ...DEFAULT_BRANDING.colors, ...(branding.colors || {}) };
    const issues = [];
    const checkPair = (id, foreground, background, minimum = 4.5) => {
        const ratio = contrastRatio(foreground, background);
        if (ratio !== null && ratio < minimum) {
            issues.push({
                id,
                severity: ratio < 3 ? 'error' : 'warning',
                ratio: Number(ratio.toFixed(2)),
                minimum,
                message: `${id} contrast ratio ${ratio.toFixed(2)} is below ${minimum}:1`
            });
        }
    };

    checkPair('page-text', colors.textPrimary, colors.bgPrimary);
    checkPair('card-text', colors.textPrimary, colors.bgSecondary);
    checkPair('muted-text', colors.textSecondary, colors.bgSecondary, 3);
    checkPair('button-primary', '#ffffff', colors.accentBlue, 3);

    [
        { id: 'console-background', type: branding.bgType, overlay: branding.bgOverlay },
        { id: 'login-background', type: branding.loginBgType, overlay: branding.loginBgOverlay || branding.bgOverlay },
        { id: 'rdclient-background', type: branding.rdclientBgType, overlay: branding.rdclientBgOverlay || branding.bgOverlay }
    ].forEach((item) => {
        if ((item.type === 'image' || item.type === 'gradient') && (clampNumber(item.overlay, 0, 95) || 0) < 25) {
            issues.push({
                id: item.id,
                severity: 'warning',
                message: `${item.id} uses ${item.type} with a low overlay; text may be hard to read.`
            });
        }
    });

    return {
        ok: !issues.some((issue) => issue.severity === 'error'),
        issues
    };
}

function getPublicAppearance() {
    const branding = getBranding();
    const appearance = getAppearanceModel(branding);
    const colors = appearance.palette.colors || {};
    const fallback = {
        bgPrimary: '#0d1117',
        bgSecondary: '#161b22',
        bgTertiary: '#21262d',
        textPrimary: '#e6edf3',
        textSecondary: '#8b949e',
        accentBlue: '#58a6ff',
        accentBlueHover: '#79c0ff',
        accentGreen: '#2ea44f',
        accentRed: '#f85149',
        accentYellow: '#d29922',
        borderPrimary: '#30363d'
    };
    const rdclientBackground = appearance.backgrounds.rdclient.type === 'inherit'
        ? appearance.backgrounds.console
        : appearance.backgrounds.rdclient;

    return {
        version: '2.0',
        revision: getBrandingRevision(),
        product: 'betterdesk-appearance',
        identity: {
            appName: appearance.identity.appName || 'BetterDesk',
            appDescription: appearance.identity.appDescription || '',
            logoType: appearance.identity.logoType || 'icon',
            logoIcon: appearance.identity.logoIcon || 'dns',
            logoUrl: appearance.identity.logoType === 'image' ? appearance.identity.logoUrl : '',
            logoText: appearance.identity.logoType === 'text' ? appearance.identity.logoText : '',
            logoTextAccent: appearance.identity.logoType === 'text' ? appearance.identity.logoTextAccent : ''
        },
        palette: {
            mode: appearance.palette.mode || 'dark',
            primary: colors.accentBlue || fallback.accentBlue,
            primaryHover: colors.accentBlueHover || fallback.accentBlueHover,
            background: colors.bgPrimary || fallback.bgPrimary,
            surface: colors.bgSecondary || fallback.bgSecondary,
            surfaceRaised: colors.bgTertiary || fallback.bgTertiary,
            text: colors.textPrimary || fallback.textPrimary,
            muted: colors.textSecondary || fallback.textSecondary,
            border: colors.borderPrimary || fallback.borderPrimary,
            danger: colors.accentRed || fallback.accentRed,
            warning: colors.accentYellow || fallback.accentYellow,
            success: colors.accentGreen || fallback.accentGreen
        },
        surfaces: {
            glassEnabled: appearance.surfaces.glassEnabled,
            glassBlur: appearance.surfaces.glassBlur,
            glassOpacity: appearance.surfaces.glassOpacity
        },
        background: {
            type: rdclientBackground.type || 'none',
            color: rdclientBackground.color || '',
            gradient: rdclientBackground.gradient || '',
            imageUrl: rdclientBackground.imageUrl || '',
            overlay: rdclientBackground.overlay || '',
            size: normalizeBackgroundSize(rdclientBackground.size || 'cover')
        },
        readability: assessAppearanceReadability(branding)
    };
}

/**
 * Generate favicon SVG from branding
 * @returns {string} SVG markup for favicon
 */
function generateFavicon() {
    const branding = getBranding();
    
    // If custom favicon SVG is set, use it
    if (branding.faviconSvg && branding.faviconSvg.trim()) {
        return branding.faviconSvg;
    }
    
    // Generate from branding colors (use accent color or default blue)
    const bgColor = branding.colors.bgPrimary || '#0d1117';
    const accentColor = branding.colors.accentBlue || '#58a6ff';
    const greenColor = branding.colors.accentGreen || '#2ea44f';
    
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="6" fill="${bgColor}"/>
  <path d="M8 10h16M8 16h16M8 22h12" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="24" cy="22" r="3" fill="${greenColor}"/>
</svg>`;
}

/**
 * Export a branding preset as JSON (for import/export)
 * @returns {Object} Full branding config for export
 */
function exportPreset() {
    const branding = getBranding();
    return {
        version: '2.0',
        type: 'betterdesk-theme',
        appearance: getAppearanceModel(branding),
        // Keep the flat shape in exports so older panels can still import most
        // fields without understanding the v2 appearance model.
        branding
    };
}

/**
 * Import a branding preset from JSON
 * @param {Object} preset - Preset object with version + branding fields
 * @returns {boolean} Success
 */
async function importPreset(preset) {
    if (!preset || preset.type !== 'betterdesk-theme' || (!preset.branding && !preset.appearance)) {
        return false;
    }
    
    // Validate and sanitize
    const allowed = Object.keys(DEFAULT_BRANDING);
    const sanitized = {};
    const input = preset.appearance
        ? flattenAppearanceInput({ appearance: preset.appearance })
        : flattenAppearanceInput(preset.branding);
    
    for (const key of allowed) {
        if (key in input) {
            if (key === 'colors') {
                const allowedColors = Object.keys(DEFAULT_BRANDING.colors);
                const colors = {};
                for (const ck of allowedColors) {
                    if (input.colors && ck in input.colors) {
                        colors[ck] = String(input.colors[ck]).substring(0, 100);
                    }
                }
                sanitized.colors = colors;
            } else {
                // Limit string length for safety (larger caps for markup/CSS fields)
                let cap = 500;
                if (key === 'logoSvg' || key === 'faviconSvg') cap = 50000;
                else if (key === 'customCss') cap = 20000;
                else if (key === 'bgGradient' || key === 'loginBgGradient' ||
                         key === 'agentBgGradient' || key === 'rdclientBgGradient') cap = 1000;
                sanitized[key] = String(input[key]).substring(0, cap);
            }
        }
    }
    
    await saveBranding(sanitized);
    return true;
}

/**
 * Invalidate the branding cache (call after DB changes)
 */
function invalidateCache() {
    brandingCache = null;
}

module.exports = {
    DEFAULT_BRANDING,
    COLOR_TO_CSS_VAR,
    BUILTIN_THEME_PALETTES,
    normalizeThemeMode,
    resolveThemeColors,
    loadBranding,
    getBranding,
    saveBranding,
    resetBranding,
    generateThemeCss,
    generateFavicon,
    exportPreset,
    importPreset,
    invalidateCache,
    getBrandingRevision,
    listProfiles,
    createProfile,
    updateProfile,
    applyProfile,
    deleteProfile,
    duplicateProfile,
    getAppearanceModel,
    getPublicAppearance,
    assessAppearanceReadability,
    flattenAppearanceInput,
    sanitizeSvg,
    sanitizeCssColorValue,
    sanitizeCustomCss,
    buildBackgroundValue,
    normalizeBackgroundSize,
    validateBrandingUrl
};
