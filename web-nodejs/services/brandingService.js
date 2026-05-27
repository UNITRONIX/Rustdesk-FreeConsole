/**
 * BetterDesk Console - Branding Service
 * Manages white-label branding configuration (name, logo, colors, favicon)
 * Stored in auth.db branding_config table
 */

const db = require('./database');
const fontService = require('./fontService');

// Dangerous SVG elements that can execute scripts or fetch external resources.
// Includes <style> (CSS @import/expression XSS vectors) and <use> (xlink:href external SVG inclusion).
const SVG_DANGEROUS_TAGS = /<\s*(script|foreignobject|iframe|embed|object|applet|animate|set|style|use|image)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SVG_DANGEROUS_TAGS_SELFCLOSING = /<\s*(script|foreignobject|iframe|embed|object|applet|style|use|image)\b[^>]*\/>/gi;

// Dangerous attributes that can execute JavaScript or trigger external fetches.
const SVG_DANGEROUS_ATTRS = /\s(on\w+|xlink:href\s*=\s*["']\s*(?:javascript|data|vbscript|file):)[^>]*/gi;
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

    // Remove dangerous elements.
    sanitized = sanitized.replace(SVG_DANGEROUS_TAGS, '');
    sanitized = sanitized.replace(SVG_DANGEROUS_TAGS_SELFCLOSING, '');

    // Remove event handler attributes & dangerous href schemes.
    sanitized = sanitized.replace(SVG_DANGEROUS_ATTRS, '');
    sanitized = sanitized.replace(SVG_JAVASCRIPT_HREF, ' href="#"');

    // Defuse CSS expression() and @import inside style attributes.
    sanitized = sanitized.replace(SVG_CSS_EXPRESSION, 'blocked-');

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
    }
};

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

// In-memory cache
let brandingCache = null;

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
        return branding;
    } catch (err) {
        console.error('[Branding] Failed to load from DB, using defaults:', err.message);
        brandingCache = JSON.parse(JSON.stringify(DEFAULT_BRANDING));
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
    for (const [key, value] of Object.entries(updates)) {
        if (key === 'colors') {
            entries.push({ key, value: JSON.stringify(value) });
        } else if (key in DEFAULT_BRANDING) {
            // Security: Sanitize SVG content to prevent XSS
            if (key === 'logoSvg' || key === 'faviconSvg') {
                entries.push({ key, value: sanitizeSvg(String(value)) });            } else if (key === 'logoUrl' || key === 'faviconUrl') {
                // Security: Validate URL scheme to prevent javascript:/data:/file:/protocol-relative XSS/SSRF.
                const normalized = validateBrandingUrl(value);
                if (normalized === null) continue; // skip invalid value, keep previous DB value
                entries.push({ key, value: normalized });            } else {
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

    // Clear cache — next getBranding() will return defaults
    brandingCache = null;
}

/**
 * Generate CSS :root overrides from branding colors and fonts
 * @returns {string} CSS string with @font-face imports and :root variable overrides
 */
function generateThemeCss() {
    const branding = getBranding();
    const overrides = [];
    
    for (const [key, cssVar] of Object.entries(COLOR_TO_CSS_VAR)) {
        const value = branding.colors[key];
        if (value && value.trim()) {
            // For muted colors, auto-generate rgba if a hex color is provided
            if (key.endsWith('Muted') && value.startsWith('#')) {
                const hex = value.replace('#', '');
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
    
    // Color overrides
    if (overrides.length > 0) {
        css += `:root {\n${overrides.join('\n')}\n}\n`;
    }
    
    return css;
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
        version: '1.0',
        type: 'betterdesk-theme',
        branding
    };
}

/**
 * Import a branding preset from JSON
 * @param {Object} preset - Preset object with version + branding fields
 * @returns {boolean} Success
 */
async function importPreset(preset) {
    if (!preset || preset.type !== 'betterdesk-theme' || !preset.branding) {
        return false;
    }
    
    // Validate and sanitize
    const allowed = Object.keys(DEFAULT_BRANDING);
    const sanitized = {};
    
    for (const key of allowed) {
        if (key in preset.branding) {
            if (key === 'colors') {
                const allowedColors = Object.keys(DEFAULT_BRANDING.colors);
                const colors = {};
                for (const ck of allowedColors) {
                    if (ck in preset.branding.colors) {
                        colors[ck] = String(preset.branding.colors[ck]).substring(0, 100);
                    }
                }
                sanitized.colors = colors;
            } else {
                // Limit string length for safety
                sanitized[key] = String(preset.branding[key]).substring(0, key === 'logoSvg' || key === 'faviconSvg' ? 50000 : 500);
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
    loadBranding,
    getBranding,
    saveBranding,
    resetBranding,
    generateThemeCss,
    generateFavicon,
    exportPreset,
    importPreset,
    invalidateCache,
    sanitizeSvg,
    validateBrandingUrl
};
