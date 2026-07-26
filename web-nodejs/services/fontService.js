/**
 * BetterDesk Console - Font Service
 * Manages Google Fonts search, preview, and local caching
 * Fonts are downloaded to public/fonts/ for self-hosting (no external CDN dependency)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { resolveChildPath } = require('../lib/safePath');

const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts');
const FONT_CACHE_FILE = path.join(__dirname, '..', 'data', 'google-fonts-cache.json');
const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/css2';

// Popular curated font list (no API key needed — we use the CSS API directly)
// This list covers the most popular Google Fonts suitable for UI/branding
const CURATED_FONTS = [
    { family: 'Inter', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Roboto', category: 'sans-serif', variants: ['300', '400', '500', '700'] },
    { family: 'Open Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Montserrat', category: 'sans-serif', variants: ['300', '400', '500', '600', '700', '800'] },
    { family: 'Poppins', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Lato', category: 'sans-serif', variants: ['300', '400', '700'] },
    { family: 'Nunito', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Nunito Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Raleway', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Source Sans 3', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Work Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'DM Sans', category: 'sans-serif', variants: ['400', '500', '700'] },
    { family: 'Plus Jakarta Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Manrope', category: 'sans-serif', variants: ['300', '400', '500', '600', '700', '800'] },
    { family: 'Outfit', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Space Grotesk', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Sora', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Urbanist', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Figtree', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Geist', category: 'sans-serif', variants: ['400', '500', '600', '700'] },
    { family: 'Rubik', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Barlow', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Barlow Condensed', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Archivo', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Lexend', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Mulish', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Quicksand', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Cabin', category: 'sans-serif', variants: ['400', '500', '600', '700'] },
    { family: 'Exo 2', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Overpass', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Red Hat Display', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Albert Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'IBM Plex Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Noto Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Josefin Sans', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Oswald', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Bebas Neue', category: 'sans-serif', variants: ['400'] },
    // Serif fonts
    { family: 'Playfair Display', category: 'serif', variants: ['400', '500', '600', '700'] },
    { family: 'Merriweather', category: 'serif', variants: ['300', '400', '700'] },
    { family: 'Lora', category: 'serif', variants: ['400', '500', '600', '700'] },
    { family: 'Libre Baskerville', category: 'serif', variants: ['400', '700'] },
    { family: 'Crimson Text', category: 'serif', variants: ['400', '600', '700'] },
    { family: 'Source Serif 4', category: 'serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'IBM Plex Serif', category: 'serif', variants: ['300', '400', '500', '600', '700'] },
    // Monospace fonts
    { family: 'JetBrains Mono', category: 'monospace', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Fira Code', category: 'monospace', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Source Code Pro', category: 'monospace', variants: ['300', '400', '500', '600', '700'] },
    { family: 'IBM Plex Mono', category: 'monospace', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Roboto Mono', category: 'monospace', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Space Mono', category: 'monospace', variants: ['400', '700'] },
    // Display/decorative
    { family: 'Righteous', category: 'display', variants: ['400'] },
    { family: 'Orbitron', category: 'sans-serif', variants: ['400', '500', '600', '700'] },
    { family: 'Syncopate', category: 'sans-serif', variants: ['400', '700'] },
    { family: 'Audiowide', category: 'display', variants: ['400'] },
    { family: 'Rajdhani', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Chakra Petch', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Saira', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Titillium Web', category: 'sans-serif', variants: ['300', '400', '600', '700'] },
    { family: 'Teko', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
    { family: 'Prompt', category: 'sans-serif', variants: ['300', '400', '500', '600', '700'] },
];

/**
 * Ensure fonts directory exists
 */
function ensureFontsDir() {
    if (!fs.existsSync(FONTS_DIR)) {
        fs.mkdirSync(FONTS_DIR, { recursive: true });
    }
}

/**
 * Fetch content from a URL (follows redirects)
 * @param {string} url
 * @returns {Promise<{data: Buffer, contentType: string}>}
 */
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                // Request woff2 format (best compression)
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                data: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || ''
            }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

/**
 * Search available fonts
 * @param {string} query - Search query (empty = all)
 * @param {string} category - Filter by category ('all', 'sans-serif', 'serif', 'monospace', 'display')
 * @returns {Array} Matching fonts
 */
function searchFonts(query = '', category = 'all') {
    let fonts = [...CURATED_FONTS];

    if (category && category !== 'all') {
        fonts = fonts.filter(f => f.category === category);
    }

    if (query && query.trim()) {
        const q = query.toLowerCase().trim();
        fonts = fonts.filter(f => f.family.toLowerCase().includes(q));
    }

    // Mark which fonts are already downloaded
    ensureFontsDir();
    return fonts.map(f => ({
        ...f,
        downloaded: isFontDownloaded(f.family)
    }));
}

/**
 * Check if a font is already downloaded locally
 * @param {string} family
 * @returns {boolean}
 */
function isFontDownloaded(family) {
    const safeName = sanitizeFontName(family);
    const fontDir = resolveFontDir(safeName);
    return fs.existsSync(fontDir) && fs.readdirSync(fontDir).some(f => f.endsWith('.woff2'));
}

/**
 * Sanitize font family name for filesystem use
 * @param {string} family
 * @returns {string}
 */
function sanitizeFontName(family) {
    const safeName = String(family || '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
    if (!safeName || safeName === '.' || safeName === '..') {
        throw new Error('Invalid font family name');
    }
    return safeName;
}

function escapeCssString(value) {
    return String(value || '').replace(/[\0-\x1F\x7F\\'"]/g, (char) => {
        if (char === '\\') return '\\\\';
        if (char === "'") return "\\'";
        if (char === '"') return '\\"';
        return `\\${char.charCodeAt(0).toString(16)} `;
    });
}

function resolveFontDir(safeName) {
    return resolveChildPath(FONTS_DIR, safeName);
}

function resolveFontFile(safeName, fileName) {
    const base = path.basename(String(fileName || ''));
    if (!base || base === '.' || base === '..') {
        throw new Error('Invalid font file name');
    }
    return resolveChildPath(resolveFontDir(safeName), base);
}

/**
 * Download a Google Font and store locally
 * Downloads woff2 files for specified weights
 * @param {string} family - Font family name
 * @param {string[]} weights - Weight variants to download (e.g. ['400', '700'])
 * @returns {Promise<{success: boolean, path: string, files: string[]}>}
 */
async function downloadFont(family, weights = ['400', '500', '600', '700']) {
    ensureFontsDir();

    const fontInfo = CURATED_FONTS.find(f => f.family === family);
    let availableWeights = weights;
    if (fontInfo) {
        availableWeights = weights.filter(w => fontInfo.variants.includes(w));
        if (availableWeights.length === 0) {
            availableWeights.push(fontInfo.variants[0] || '400');
        }
    } else {
        availableWeights = weights.filter(w => /^\d{3}$/.test(String(w)));
        if (availableWeights.length === 0) availableWeights = ['400', '700'];
    }

    const safeName = sanitizeFontName(family);
    const fontDir = resolveFontDir(safeName);

    if (!fs.existsSync(fontDir)) {
        fs.mkdirSync(fontDir, { recursive: true });
    }

    // Fetch CSS from Google Fonts to get woff2 URLs
    const weightParam = availableWeights.join(';');
    const cssUrl = `${GOOGLE_FONTS_CSS_URL}?family=${encodeURIComponent(family)}:wght@${weightParam}&display=swap`;

    const cssResponse = await fetchUrl(cssUrl);
    const cssText = cssResponse.data.toString('utf-8');

    // Parse woff2 URLs from CSS
    const urlRegex = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g;
    const weightRegex = /font-weight:\s*(\d+)/g;
    const blocks = cssText.split(/\}\s*/);

    const downloadedFiles = [];

    for (const block of blocks) {
        const urlMatch = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(block);
        const weightMatch = /font-weight:\s*(\d+)/.exec(block);
        // Only download latin subset
        if (!urlMatch || !block.includes('latin') || block.includes('latin-ext')) continue;

        const fileUrl = urlMatch[1];
        const weight = weightMatch ? weightMatch[1] : '400';
        const fileName = `${safeName}-${weight}.woff2`;
        const filePath = resolveFontFile(safeName, fileName);

        try {
            const fontResponse = await fetchUrl(fileUrl);
            fs.writeFileSync(filePath, fontResponse.data);
            downloadedFiles.push(fileName);
        } catch (err) {
            console.error(`[Fonts] Failed to download ${fileName}:`, err.message);
        }
    }

    // Generate local @font-face CSS
    if (downloadedFiles.length > 0) {
        const cssFaces = downloadedFiles.map(file => {
            const weightMatch = file.match(/-(\d+)\.woff2$/);
            const weight = (weightMatch && /^\d+$/.test(weightMatch[1])) ? weightMatch[1] : '400';
            const cssFamily = escapeCssString(String(family).trim() || 'sans-serif');
            return [
                '@font-face {',
                `    font-family: '${cssFamily}';`,
                '    font-style: normal;',
                `    font-weight: ${weight};`,
                '    font-display: swap;',
                `    src: url('/fonts/${safeName}/${file}') format('woff2');`,
                '}',
            ].join('\n');
        }).join('\n\n');

        fs.writeFileSync(resolveFontFile(safeName, 'font.css'), cssFaces);
    }

    return {
        success: downloadedFiles.length > 0,
        path: `/fonts/${safeName}`,
        files: downloadedFiles,
        cssPath: `/fonts/${safeName}/font.css`
    };
}

/**
 * Search Google Fonts catalog (curated + cache + optional API key).
 * @param {string} query
 * @param {string} category
 * @returns {Array}
 */
function searchGoogleFonts(query = '', category = 'all') {
    let fonts = searchFonts(query, category);

    if (query && query.trim()) {
        const q = query.trim();
        const exact = fonts.find(f => f.family.toLowerCase() === q.toLowerCase());
        if (!exact && /^[a-zA-Z0-9][a-zA-Z0-9\s.'-]{1,60}$/.test(q)) {
            fonts.unshift({
                family: q,
                category: 'sans-serif',
                variants: ['400', '700'],
                downloaded: isFontDownloaded(q),
                source: 'google-custom'
            });
        }
    }

    if (fs.existsSync(FONT_CACHE_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(FONT_CACHE_FILE, 'utf8'));
            if (Array.isArray(cached)) {
                const q = query.toLowerCase().trim();
                const extra = cached.filter(f => {
                    if (category && category !== 'all' && f.category !== category) return false;
                    if (!q) return true;
                    return f.family.toLowerCase().includes(q);
                });
                const seen = new Set(fonts.map(f => f.family.toLowerCase()));
                for (const f of extra) {
                    if (!seen.has(f.family.toLowerCase())) {
                        fonts.push({
                            ...f,
                            downloaded: isFontDownloaded(f.family)
                        });
                        seen.add(f.family.toLowerCase());
                    }
                }
            }
        } catch (_) { /* ignore cache parse errors */ }
    }

    return fonts.slice(0, 80);
}

/**
 * Register an uploaded custom font file and generate local @font-face CSS.
 * @param {string} family - Display family name
 * @param {string} filePath - Temp uploaded path
 * @param {string} fileName - Destination filename
 */
async function registerUploadedFont(family, filePath, fileName) {
    ensureFontsDir();
    const displayFamily = String(family || 'Custom Font').trim().substring(0, 80);
    if (!displayFamily) throw new Error('Font family name is required');

    const safeName = sanitizeFontName(displayFamily);
    const fontDir = resolveFontDir(safeName);
    if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir, { recursive: true });

    const ext = path.extname(fileName).toLowerCase();
    const destName = ext === '.ttf' ? `${safeName}.ttf` : `${safeName}-400.woff2`;
    const destPath = resolveFontFile(safeName, destName);
    fs.copyFileSync(filePath, destPath);
    try { fs.unlinkSync(filePath); } catch (_) { /* temp cleanup */ }

    const format = ext === '.ttf' ? 'truetype' : 'woff2';
    const cssFamily = escapeCssString(displayFamily);
    const css = [
        '@font-face {',
        `    font-family: '${cssFamily}';`,
        '    font-style: normal;',
        '    font-weight: 400;',
        '    font-display: swap;',
        `    src: url('/fonts/${safeName}/${destName}') format('${format}');`,
        '}',
    ].join('\n');
    fs.writeFileSync(resolveFontFile(safeName, 'font.css'), css);
    fs.writeFileSync(resolveFontFile(safeName, 'meta.json'), JSON.stringify({
        family: displayFamily,
        category: 'custom',
        source: 'upload'
    }));

    return {
        family: displayFamily,
        safeName,
        cssPath: `/fonts/${safeName}/font.css`,
        downloaded: true
    };
}

/**
 * Get locally downloaded font info
 * @param {string} family
 * @returns {{available: boolean, cssPath: string, weights: string[]}|null}
 */
function getLocalFont(family) {
    const safeName = sanitizeFontName(family);
    const fontDir = resolveFontDir(safeName);
    const cssFile = resolveFontFile(safeName, 'font.css');

    if (!fs.existsSync(cssFile)) return null;

    const files = fs.readdirSync(fontDir).filter(f => f.endsWith('.woff2'));
    const weights = files.map(f => f.match(/-(\d+)\.woff2$/)?.[1]).filter(Boolean);

    return {
        available: true,
        cssPath: `/fonts/${safeName}/font.css`,
        weights,
        fileCount: files.length
    };
}

/**
 * List all locally downloaded fonts
 * @returns {Array<{family: string, safeName: string, cssPath: string, weights: string[]}>}
 */
function listLocalFonts() {
    ensureFontsDir();
    const dirs = fs.readdirSync(FONTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

    const fonts = [];
    for (const dir of dirs) {
        let fontDir;
        try {
            fontDir = resolveFontDir(dir.name);
        } catch (_) {
            continue;
        }
        const cssFile = resolveFontFile(dir.name, 'font.css');
        if (!fs.existsSync(cssFile)) continue;

        const files = fs.readdirSync(fontDir).filter(f => f.endsWith('.woff2'));
        const weights = files.map(f => f.match(/-(\d+)\.woff2$/)?.[1]).filter(Boolean);

        // Find original family name from curated list or meta.json
        let displayFamily = dir.name;
        let category = 'sans-serif';
        const metaFile = resolveFontFile(dir.name, 'meta.json');
        if (fs.existsSync(metaFile)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                if (meta.family) displayFamily = meta.family;
                if (meta.category) category = meta.category;
            } catch (_) { /* ignore */ }
        } else {
            const match = CURATED_FONTS.find(f => sanitizeFontName(f.family) === dir.name);
            if (match) {
                displayFamily = match.family;
                category = match.category;
            }
        }

        fonts.push({
            family: displayFamily,
            safeName: dir.name,
            category,
            cssPath: `/fonts/${dir.name}/font.css`,
            weights,
            fileCount: files.length
        });
    }

    return fonts;
}

/**
 * Delete a locally downloaded font
 * @param {string} family
 * @returns {boolean}
 */
function deleteLocalFont(family) {
    const safeName = sanitizeFontName(family);
    const fontDir = resolveFontDir(safeName);

    if (!fs.existsSync(fontDir)) return false;

    fs.rmSync(fontDir, { recursive: true, force: true });
    return true;
}

/**
 * Generate @font-face CSS imports for active branding fonts.
 * Called by brandingService.generateThemeCss() to include font definitions.
 * @param {string} headingFont - Font family for headings
 * @param {string} bodyFont - Font family for body text
 * @returns {string} CSS @font-face + variable overrides
 */
function generateFontCss(headingFont, bodyFont) {
    const imports = [];
    const vars = [];

    if (headingFont && headingFont.trim()) {
        const trimmedHeadingFont = headingFont.trim();
        const local = getLocalFont(trimmedHeadingFont);
        if (local) {
            imports.push(`@import url('${local.cssPath}');`);
        }
        vars.push(`    --font-heading: '${escapeCssString(trimmedHeadingFont)}', sans-serif;`);
    }

    if (bodyFont && bodyFont.trim()) {
        const trimmedBodyFont = bodyFont.trim();
        const local = getLocalFont(trimmedBodyFont);
        if (local) {
            // Only add import if it's a different font
            if (trimmedBodyFont !== String(headingFont || '').trim()) {
                imports.push(`@import url('${local.cssPath}');`);
            }
        }
        vars.push(`    --font-family: '${escapeCssString(trimmedBodyFont)}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`);
    }

    let css = '';
    if (imports.length > 0) {
        css += imports.join('\n') + '\n\n';
    }
    if (vars.length > 0) {
        css += `:root {\n${vars.join('\n')}\n}\n`;
    }

    // Apply heading font to heading elements (never UX 3.5 chrome nav)
    if (headingFont && headingFont.trim()) {
        css += `\nh1, h2, h3, h4, h5, h6,
.page-title, .settings-section-title, .login-title,
.sidebar-logo-text, .brand-text-logo,
.desktop-login-brand { font-family: var(--font-heading, var(--font-family)); }
.ux35-shell .ux35-sidebar,
.ux35-shell .ux35-sidebar :is(h1, h2, h3, h4, h5, h6),
.ux35-shell .ux35-topbar { font-family: var(--ux35-font-chrome, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif); }\n`;
    }

    return css;
}

module.exports = {
    CURATED_FONTS,
    searchFonts,
    searchGoogleFonts,
    isFontDownloaded,
    downloadFont,
    getLocalFont,
    listLocalFonts,
    deleteLocalFont,
    registerUploadedFont,
    generateFontCss,
    sanitizeFontName,
    escapeCssString
};
