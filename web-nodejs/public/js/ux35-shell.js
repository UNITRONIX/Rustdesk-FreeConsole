/**
 * BetterDesk Console — UX 3.5 Shell Controller
 * Drawer (tablet/mobile), sidebar resize, theme icon sync.
 */
(function () {
    'use strict';

    var STORAGE_WIDTH = 'bd_ux35_sidebar_width';
    var WIDTH_MIN = 200;
    var WIDTH_MAX = 320;
    var WIDTH_DEFAULT = 220;
    var MQ_DRAWER = window.matchMedia('(max-width: 1099px)');

    function t(key, fb) {
        return (typeof _ === 'function' ? _(key) : fb) || fb;
    }

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function applySidebarWidth(px) {
        var w = clamp(px, WIDTH_MIN, WIDTH_MAX);
        document.documentElement.style.setProperty('--ux35-sidebar-width', w + 'px');
        return w;
    }

    function restoreSidebarWidth() {
        if (MQ_DRAWER.matches) return;
        try {
            var saved = parseInt(localStorage.getItem(STORAGE_WIDTH), 10);
            if (saved && !isNaN(saved)) applySidebarWidth(saved);
            else applySidebarWidth(WIDTH_DEFAULT);
        } catch (e) {
            applySidebarWidth(WIDTH_DEFAULT);
        }
    }

    function setDrawerOpen(open) {
        var shell = document.getElementById('app');
        var overlay = document.getElementById('ux35-sidebar-overlay');
        var btn = document.getElementById('ux35-menu-btn');
        if (!shell) return;
        shell.classList.toggle('ux35-drawer-open', open);
        if (overlay) {
            overlay.hidden = !open;
            overlay.classList.toggle('visible', open);
        }
        if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.body.style.overflow = open && MQ_DRAWER.matches ? 'hidden' : '';
    }

    function syncThemeIcon() {
        var icon = document.getElementById('ux35-theme-icon');
        if (!icon) return;
        var mode = document.documentElement.getAttribute('data-theme-mode') || 'dark';
        var theme = document.documentElement.getAttribute('data-theme') || 'dark';
        if (mode === 'custom') {
            icon.textContent = 'palette';
        } else if (theme === 'light') {
            icon.textContent = 'light_mode';
        } else {
            icon.textContent = 'dark_mode';
        }
    }

    var THEME_PALETTES = {
        dark: {
            bgPrimary: '#0d1117', bgSecondary: '#161b22', bgTertiary: '#21262d', bgElevated: '#30363d',
            textPrimary: '#e6edf3', textSecondary: '#8b949e',
            accentBlue: '#58a6ff', accentBlueHover: '#79c0ff', accentBlueMuted: '#58a6ff',
            accentGreen: '#2ea44f', accentGreenHover: '#3fb950', accentGreenMuted: '#2ea44f',
            accentRed: '#f85149', accentRedHover: '#ff6b6b', accentRedMuted: '#f85149',
            accentYellow: '#d29922', accentYellowHover: '#e3b341', accentYellowMuted: '#d29922',
            accentPurple: '#a371f7', accentPurpleHover: '#bc8cff', accentPurpleMuted: '#a371f7',
            borderPrimary: '#30363d', borderSecondary: '#21262d'
        },
        light: {
            bgPrimary: '#f0f2f5', bgSecondary: '#ffffff', bgTertiary: '#eaeef2', bgElevated: '#ffffff',
            textPrimary: '#1f2328', textSecondary: '#656d76',
            accentBlue: '#0969da', accentBlueHover: '#0550ae', accentBlueMuted: '#0969da',
            accentGreen: '#1a7f37', accentGreenHover: '#116329', accentGreenMuted: '#1a7f37',
            accentRed: '#cf222e', accentRedHover: '#a40e26', accentRedMuted: '#cf222e',
            accentYellow: '#9a6700', accentYellowHover: '#7d4e00', accentYellowMuted: '#9a6700',
            accentPurple: '#8250df', accentPurpleHover: '#6639ba', accentPurpleMuted: '#8250df',
            borderPrimary: '#d0d7de', borderSecondary: '#eaeef2'
        }
    };

    function applyThemeLocally(next) {
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.setAttribute('data-theme-mode', next);
        var palette = THEME_PALETTES[next] || THEME_PALETTES.dark;
        var root = document.documentElement.style;
        var map = {
            bgPrimary: '--bg-primary', bgSecondary: '--bg-secondary', bgTertiary: '--bg-tertiary',
            bgElevated: '--bg-elevated', textPrimary: '--text-primary', textSecondary: '--text-secondary',
            accentBlue: '--accent-blue', accentBlueHover: '--accent-blue-hover', accentBlueMuted: '--accent-blue-muted',
            accentGreen: '--accent-green', accentGreenHover: '--accent-green-hover', accentGreenMuted: '--accent-green-muted',
            accentRed: '--accent-red', accentRedHover: '--accent-red-hover', accentRedMuted: '--accent-red-muted',
            accentYellow: '--accent-yellow', accentYellowHover: '--accent-yellow-hover', accentYellowMuted: '--accent-yellow-muted',
            accentPurple: '--accent-purple', accentPurpleHover: '--accent-purple-hover', accentPurpleMuted: '--accent-purple-muted',
            borderPrimary: '--border-primary', borderSecondary: '--border-secondary'
        };
        Object.keys(palette).forEach(function (key) {
            if (map[key]) root.setProperty(map[key], palette[key]);
        });
        // Soft glass for light/dark until branding.css reloads
        if (next === 'light') {
            root.setProperty('--surface-glass-bg-secondary', 'rgba(255,255,255,0.82)');
            root.setProperty('--surface-glass-bg-elevated', 'rgba(255,255,255,0.9)');
            root.setProperty('--surface-glass-border', 'rgba(208,215,222,0.9)');
            root.setProperty('--card-bg', 'rgba(255,255,255,0.92)');
            root.setProperty('--ux35-topbar-bg', palette.accentBlue);
            root.setProperty('--ux35-topbar-fg', '#ffffff');
            root.setProperty('--ux35-topbar-fg-muted', 'rgba(255,255,255,0.78)');
        } else {
            root.setProperty('--surface-glass-bg-secondary', 'rgba(22,27,34,0.55)');
            root.setProperty('--surface-glass-bg-elevated', 'rgba(48,54,61,0.7)');
            root.setProperty('--surface-glass-border', 'rgba(48,54,61,0.5)');
            root.setProperty('--card-bg', 'rgba(22,27,34,0.55)');
            root.removeProperty('--ux35-topbar-bg');
            root.removeProperty('--ux35-topbar-fg');
            root.removeProperty('--ux35-topbar-fg-muted');
        }
        root.setProperty('--ux35-bg', palette.bgPrimary);
        root.setProperty('--ux35-text', palette.textPrimary);
        root.setProperty('--ux35-muted', palette.textSecondary);
        root.setProperty('--ux35-primary', palette.accentBlue);
        syncThemeIcon();
    }

    /**
     * Cycle visual theme: dark ↔ light.
     * Persists themeMode + built-in palette so branding.css matches data-theme.
     */
    function cycleThemePreview() {
        var mode = document.documentElement.getAttribute('data-theme-mode') || 'dark';
        if (mode === 'custom') {
            window.location.href = '/settings#branding';
            return;
        }
        var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        applyThemeLocally(next);

        if (window.BetterDesk && window.BetterDesk.csrfToken) {
            fetch('/api/settings/branding', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.BetterDesk.csrfToken
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    themeMode: next,
                    colors: THEME_PALETTES[next],
                    glassColor: next === 'light' ? '#ffffff' : '#161b22'
                })
            }).then(function (res) {
                if (res.ok) {
                    var link = document.querySelector('link[href*="branding.css"]');
                    if (link) {
                        var url = new URL(link.href, window.location.origin);
                        url.searchParams.set('v', String(Date.now()));
                        link.href = url.pathname + url.search;
                    }
                    if (window.BetterDesk.branding) {
                        window.BetterDesk.branding.themeMode = next;
                    }
                }
            }).catch(function () { /* ignore */ });
        }
    }

    function initResize() {
        var handle = document.getElementById('ux35-sidebar-resize');
        if (!handle) return;
        var dragging = false;

        handle.addEventListener('mousedown', function (e) {
            if (MQ_DRAWER.matches) return;
            dragging = true;
            handle.classList.add('active');
            e.preventDefault();
        });

        window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var sidebar = document.getElementById('ux35-sidebar');
            if (!sidebar) return;
            var rect = sidebar.getBoundingClientRect();
            var w = applySidebarWidth(e.clientX - rect.left);
            try { localStorage.setItem(STORAGE_WIDTH, String(w)); } catch (err) { /* ignore */ }
        });

        window.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('active');
        });
    }

    function initDrawer() {
        var menuBtn = document.getElementById('ux35-menu-btn');
        var overlay = document.getElementById('ux35-sidebar-overlay');
        var sidebar = document.getElementById('ux35-sidebar');

        if (menuBtn) {
            menuBtn.addEventListener('click', function () {
                var shell = document.getElementById('app');
                var open = !(shell && shell.classList.contains('ux35-drawer-open'));
                setDrawerOpen(open);
            });
        }
        if (overlay) {
            overlay.addEventListener('click', function () { setDrawerOpen(false); });
        }
        if (sidebar) {
            sidebar.querySelectorAll('a.ux35-sidebar-item').forEach(function (link) {
                link.addEventListener('click', function () {
                    if (MQ_DRAWER.matches) setDrawerOpen(false);
                });
            });
        }

        function onMqChange() {
            if (!MQ_DRAWER.matches) {
                setDrawerOpen(false);
                restoreSidebarWidth();
            }
        }
        if (MQ_DRAWER.addEventListener) MQ_DRAWER.addEventListener('change', onMqChange);
        else if (MQ_DRAWER.addListener) MQ_DRAWER.addListener(onMqChange);
    }

    function initHelp() {
        var helpBtn = document.getElementById('ux35-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('click', function () {
                if (typeof Tutorial !== 'undefined') Tutorial.start('console');
            });
        }
    }

    function initThemeBtn() {
        var btn = document.getElementById('ux35-theme-btn');
        if (btn) btn.addEventListener('click', cycleThemePreview);
        syncThemeIcon();
    }

    function initScrollPreserve() {
        var nav = document.getElementById('ux35-sidebar-nav');
        if (!nav) return;
        var KEY = 'bd_ux35_sidebar_scroll';
        try {
            var saved = sessionStorage.getItem(KEY);
            if (saved) nav.scrollTop = parseInt(saved, 10) || 0;
        } catch (e) { /* ignore */ }
        var active = nav.querySelector('.ux35-sidebar-item.active');
        if (active) {
            var rect = active.getBoundingClientRect();
            var navRect = nav.getBoundingClientRect();
            if (rect.top < navRect.top || rect.bottom > navRect.bottom) {
                active.scrollIntoView({ block: 'center' });
            }
        }
        window.addEventListener('beforeunload', function () {
            try { sessionStorage.setItem(KEY, String(nav.scrollTop)); } catch (e) { /* ignore */ }
        });
    }

    function init() {
        if (window.BetterDesk && window.BetterDesk.embed) return;
        restoreSidebarWidth();
        initDrawer();
        initResize();
        initHelp();
        initThemeBtn();
        initScrollPreserve();
    }

    window.Ux35Shell = {
        openDrawer: function () { setDrawerOpen(true); },
        closeDrawer: function () { setDrawerOpen(false); },
        syncThemeIcon: syncThemeIcon
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
