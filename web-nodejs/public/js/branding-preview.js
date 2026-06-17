/**
 * BetterDesk — Branding live preview engine
 * Mirrors server-side generateThemeCss() for instant panel preview.
 */
(function(global) {
    'use strict';

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

    const STYLE_ID = 'bd-branding-preview';
    const PAGE_STYLE_ID = 'bd-branding-page-preview';
    let _fontLinks = {};

    function clampNumber(value, min, max) {
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return null;
        return Math.min(max, Math.max(min, n));
    }

    function sanitizeCssColor(value) {
        if (!value) return '';
        let v = String(value).trim();
        v = v.replace(/[^a-zA-Z0-9#%.,()\s/-]/g, '');
        v = v.replace(/expression\s*\(/gi, '');
        v = v.replace(/url\s*\(/gi, '');
        return v.substring(0, 400);
    }

    function isSafeUrl(url) {
        const trimmed = String(url || '').trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.includes('..')) return false;
        if (trimmed.startsWith('/')) return true;
        try {
            const u = new URL(trimmed, window.location.origin);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    function buildBackgroundValue(type, color, gradient, imageUrl) {
        switch (type) {
            case 'color': return sanitizeCssColor(color);
            case 'gradient': return sanitizeCssColor(gradient);
            case 'image': {
                if (!isSafeUrl(imageUrl)) return '';
                const safe = String(imageUrl).replace(/["()\\]/g, encodeURIComponent);
                return `url("${safe}")`;
            }
            default: return '';
        }
    }

    function loadFontPreview(family) {
        if (!family) return;
        const key = family.replace(/\s+/g, '+');
        if (_fontLinks[key]) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600;700&display=swap`;
        document.head.appendChild(link);
        _fontLinks[key] = link;
    }

    function hexToRgb(hex) {
        const h = String(hex || '').replace('#', '').trim();
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return {
            r: parseInt(h.substring(0, 2), 16),
            g: parseInt(h.substring(2, 4), 16),
            b: parseInt(h.substring(4, 6), 16)
        };
    }

    function glassOverrides(data) {
        const lines = [];
        const enabled = data.glassEnabled !== 'false';
        if (!enabled) {
            lines.push('--surface-glass-blur: 0px;');
            lines.push('--surface-glass-saturate: 1;');
            lines.push('--surface-glass-bg-secondary: var(--bg-secondary);');
            lines.push('--surface-glass-bg-tertiary: var(--bg-tertiary);');
            lines.push('--card-bg: var(--bg-secondary);');
            return lines;
        }
        const blur = clampNumber(data.glassBlur, 0, 40) ?? 16;
        const opacity = (clampNumber(data.glassOpacity, 0, 100) ?? 55) / 100;
        let color = (data.glassColor || '').trim();
        if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
            const fallback = (data.colors && data.colors.bgSecondary) || '';
            color = /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback : '#161b22';
        }
        const rgb = hexToRgb(color);
        if (!rgb) return lines;
        lines.push(`--surface-glass-blur: ${blur}px;`);
        lines.push('--surface-glass-saturate: 1.2;');
        lines.push(`--surface-glass-bg-secondary: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity.toFixed(2)});`);
        lines.push(`--surface-glass-bg-tertiary: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(1, opacity + 0.08).toFixed(2)});`);
        lines.push('--card-bg: var(--surface-glass-bg-secondary);');
        return lines;
    }

    function colorOverrides(colors) {
        const lines = [];
        if (!colors) return lines;
        for (const [key, cssVar] of Object.entries(COLOR_TO_CSS_VAR)) {
            const value = colors[key];
            if (!value || !String(value).trim()) continue;
            if (key.endsWith('Muted') && String(value).startsWith('#')) {
                const hex = value.replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);
                lines.push(`${cssVar}: rgba(${r}, ${g}, ${b}, 0.15);`);
            } else {
                lines.push(`${cssVar}: ${value};`);
            }
        }
        return lines;
    }

    function generatePreviewCss(data) {
        const overrides = colorOverrides(data.colors);
        overrides.push(...glassOverrides(data));
        let css = '';

        if (data.fontHeading) loadFontPreview(data.fontHeading);
        if (data.fontBody && data.fontBody !== data.fontHeading) loadFontPreview(data.fontBody);

        if (data.fontHeading) {
            overrides.push(`--font-heading: '${data.fontHeading}', sans-serif;`);
        }
        if (data.fontBody) {
            overrides.push(`--font-family: '${data.fontBody}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`);
        }

        if (overrides.length) {
            css += `:root, .branding-preview-mockup {\n  ${overrides.join('\n  ')}\n}\n`;
        }

        const consoleBg = buildBackgroundValue(data.bgType, data.bgColor, data.bgGradient, data.bgImageUrl);
        if (consoleBg) {
            const overlay = clampNumber(data.bgOverlay, 0, 95);
            css += `.branding-preview-mockup {\n  background: ${consoleBg};\n  background-size: ${data.bgSize || 'cover'};\n  background-position: center;\n`;
            if (data.bgType === 'image' && clampNumber(data.bgBlur, 0, 40)) {
                css += `  filter: blur(${data.bgBlur}px);\n`;
            }
            css += `}\n`;
            if (overlay) {
                css += `.branding-preview-mockup::after {\n  content:'';position:absolute;inset:0;background:rgba(0,0,0,${(overlay / 100).toFixed(2)});pointer-events:none;border-radius:inherit;\n}\n`;
            }
        }

        return css;
    }

    function injectStyle(id, css) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = css || '';
    }

    function apply(data, options = {}) {
        const css = generatePreviewCss(data || {});
        injectStyle(STYLE_ID, css);

        if (options.applyToPage) {
            injectStyle(PAGE_STYLE_ID, css);
        }

        updateMockup(data);
    }

    function updateMockup(data) {
        const mockup = document.getElementById('branding-live-mockup');
        if (!mockup || !data) return;

        const name = data.appName || 'BetterDesk';
        const logoEl = mockup.querySelector('.branding-mockup-logo');
        const titleEl = mockup.querySelector('.branding-mockup-title');
        const bodyEl = mockup.querySelector('.branding-mockup-body');

        if (titleEl) titleEl.textContent = name;
        if (bodyEl) {
            bodyEl.style.fontFamily = data.fontBody ? `'${data.fontBody}', sans-serif` : '';
        }

        if (logoEl) {
            const type = data.logoType || 'icon';
            if (type === 'text') {
                const accent = data.logoTextAccent
                    ? `<span class="brand-text-accent">${escapeHtml(data.logoTextAccent)}</span>` : '';
                const fontStyle = data.fontHeading ? `font-family:'${escapeHtml(data.fontHeading)}',sans-serif;` : '';
                logoEl.innerHTML = `<span class="brand-text-logo" style="${fontStyle}">${escapeHtml(data.logoText || name)}${accent}</span>`;
            } else if (type === 'image' && data.logoUrl && isSafeUrl(data.logoUrl)) {
                logoEl.innerHTML = `<img src="${escapeHtml(data.logoUrl)}" alt="${escapeHtml(name)}" style="max-height:28px;">`;
            } else if (type === 'icon') {
                logoEl.innerHTML = `<span class="material-icons">${escapeHtml(data.logoIcon || 'dns')}</span><span>${escapeHtml(name)}</span>`;
            } else {
                logoEl.innerHTML = `<span class="material-icons">palette</span><span>${escapeHtml(name)}</span>`;
            }
        }
    }

    function escapeHtml(str) {
        if (global.Utils && typeof global.Utils.escapeHtml === 'function') {
            return global.Utils.escapeHtml(str);
        }
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function refreshBrandingStylesheet(revision) {
        const rev = revision || Date.now();
        document.querySelectorAll('link[href*="/css/branding.css"]').forEach(link => {
            const base = link.getAttribute('href').split('?')[0];
            link.setAttribute('href', `${base}?v=${rev}`);
        });
    }

    function clearPagePreview() {
        const el = document.getElementById(PAGE_STYLE_ID);
        if (el) el.textContent = '';
    }

    global.BrandingPreview = {
        COLOR_TO_CSS_VAR,
        apply,
        refreshBrandingStylesheet,
        clearPagePreview,
        loadFontPreview
    };
})(window);
