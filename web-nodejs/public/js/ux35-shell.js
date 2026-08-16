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
        var handle = document.getElementById('ux35-sidebar-resize');
        if (handle) handle.setAttribute('aria-valuenow', String(w));
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

    var drawerAnimTimer = null;
    var drawerFocusOrigin = null;

    function focusableIn(container) {
        if (!container) return [];
        return Array.prototype.slice.call(container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(function (el) { return el.offsetParent !== null; });
    }

    function syncDrawerAccessibility(open) {
        var sidebar = document.getElementById('ux35-sidebar');
        if (!sidebar) return;
        var drawerMode = MQ_DRAWER.matches;
        sidebar.setAttribute('aria-hidden', drawerMode && !open ? 'true' : 'false');
        if ('inert' in sidebar) sidebar.inert = drawerMode && !open;
    }

    function clearDrawerAnimating(shell) {
        if (drawerAnimTimer) {
            clearTimeout(drawerAnimTimer);
            drawerAnimTimer = null;
        }
        if (shell) shell.classList.remove('ux35-drawer-animating');
    }

    function setDrawerOpen(open) {
        var shell = document.getElementById('app');
        var overlay = document.getElementById('ux35-sidebar-overlay');
        var btn = document.getElementById('ux35-menu-btn');
        if (!shell) return;
        var wasOpen = shell.classList.contains('ux35-drawer-open');
        if (wasOpen === !!open) return;

        clearDrawerAnimating(shell);
        if (open) drawerFocusOrigin = document.activeElement;
        shell.classList.add('ux35-drawer-animating');
        shell.classList.toggle('ux35-drawer-open', open);
        syncDrawerAccessibility(open);

        if (overlay) {
            overlay.hidden = false;
            // Force layout so opacity transition runs after display/visibility restore
            void overlay.offsetWidth;
            overlay.classList.toggle('visible', open);
            overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
            if (!open) {
                var hideMs = 160;
                try {
                    var rootStyles = getComputedStyle(document.documentElement);
                    var motion = rootStyles.getPropertyValue('--ux35-motion').trim();
                    if (motion === '0ms' || motion === '0') hideMs = 0;
                } catch (e) { /* ignore */ }
                setTimeout(function () {
                    if (!shell.classList.contains('ux35-drawer-open')) {
                        overlay.hidden = true;
                    }
                }, hideMs);
            }
        }
        if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.body.style.overflow = open && MQ_DRAWER.matches ? 'hidden' : '';
        if (open) {
            window.requestAnimationFrame(function () {
                var first = focusableIn(document.getElementById('ux35-sidebar'))[0];
                if (first) first.focus({ preventScroll: true });
            });
        } else if (drawerFocusOrigin && document.contains(drawerFocusOrigin)
            && document.getElementById('ux35-sidebar').contains(document.activeElement)) {
            drawerFocusOrigin.focus({ preventScroll: true });
            drawerFocusOrigin = null;
        }

        drawerAnimTimer = setTimeout(function () {
            shell.classList.remove('ux35-drawer-animating');
            drawerAnimTimer = null;
        }, 200);
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

    var THEME_INLINE_KEYS = [
        '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated',
        '--bg-hover',
        '--text-primary', '--text-secondary',
        '--accent-blue', '--accent-blue-hover', '--accent-blue-muted',
        '--accent-green', '--accent-green-hover', '--accent-green-muted',
        '--accent-red', '--accent-red-hover', '--accent-red-muted',
        '--accent-yellow', '--accent-yellow-hover', '--accent-yellow-muted',
        '--accent-purple', '--accent-purple-hover', '--accent-purple-muted',
        '--border-primary', '--border-secondary',
        '--surface-glass-blur', '--surface-glass-saturate',
        '--surface-glass-bg-secondary', '--surface-glass-bg-tertiary',
        '--surface-glass-bg-elevated', '--surface-glass-border',
        '--card-bg',
        '--ux35-bg', '--ux35-sidebar-bg', '--ux35-card-bg', '--ux35-border',
        '--ux35-border-light', '--ux35-text', '--ux35-muted', '--ux35-hover',
        '--ux35-primary', '--ux35-active-bg', '--ux35-glass-blur', '--ux35-glass-saturate',
        '--ux35-topbar-bg', '--ux35-topbar-fg', '--ux35-topbar-fg-muted', '--ux35-topbar-border'
    ];

    function clearThemeInlineOverrides() {
        var root = document.documentElement.style;
        THEME_INLINE_KEYS.forEach(function (key) {
            root.removeProperty(key);
        });
    }

    /** Match brandingService.hexToMutedRgba — solid hex → translucent muted for theme preview. */
    function hexToMutedRgba(hex, alpha) {
        if (hex == null) return null;
        var raw = String(hex).trim().replace(/^#/, '');
        if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
        var r = parseInt(raw.substring(0, 2), 16);
        var g = parseInt(raw.substring(2, 4), 16);
        var b = parseInt(raw.substring(4, 6), 16);
        var a = (typeof alpha === 'number' && isFinite(alpha)) ? alpha : 0.15;
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    }

    function applyThemeLocally(next) {
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.setAttribute('data-theme-mode', next);
        var a11yContrast = document.documentElement.getAttribute('data-a11y-contrast');
        if (a11yContrast && a11yContrast !== 'normal') {
            /* High-contrast preferences deliberately own the palette. Do not
               add inline theme variables that would override those settings. */
            clearThemeInlineOverrides();
            syncThemeIcon();
            return;
        }
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
            if (!map[key]) return;
            var value = palette[key];
            // Muted accents must be translucent (same as branding.css) or filters/nav/avatar flash solid blue
            if (/Muted$/.test(key) && typeof value === 'string' && value.charAt(0) === '#') {
                value = hexToMutedRgba(value, 0.15) || value;
            }
            root.setProperty(map[key], value);
        });

        var accentBlueMutedCss = hexToMutedRgba(palette.accentBlueMuted, 0.15) || palette.accentBlueMuted;

        // Solid surfaces — opaque tokens so UX 3.5 repaints immediately (no glass compositor lag)
        root.setProperty('--bg-hover', next === 'light' ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.06)');
        root.setProperty('--surface-glass-blur', '0px');
        root.setProperty('--surface-glass-saturate', '1');
        root.setProperty('--surface-glass-bg-secondary', palette.bgSecondary);
        root.setProperty('--surface-glass-bg-tertiary', palette.bgTertiary);
        root.setProperty('--surface-glass-bg-elevated', palette.bgElevated);
        root.setProperty('--surface-glass-border', palette.borderPrimary);
        root.setProperty('--card-bg', palette.bgSecondary);

        root.setProperty('--ux35-bg', palette.bgPrimary);
        root.setProperty('--ux35-sidebar-bg', palette.bgSecondary);
        root.setProperty('--ux35-card-bg', palette.bgSecondary);
        root.setProperty('--ux35-border', palette.borderPrimary);
        root.setProperty('--ux35-border-light', palette.borderSecondary);
        root.setProperty('--ux35-text', palette.textPrimary);
        root.setProperty('--ux35-muted', palette.textSecondary);
        root.setProperty('--ux35-hover', next === 'light' ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.06)');
        root.setProperty('--ux35-primary', palette.accentBlue);
        root.setProperty('--ux35-active-bg', accentBlueMutedCss);
        root.setProperty('--ux35-glass-blur', '0px');
        root.setProperty('--ux35-glass-saturate', '1');

        // Topbar chrome is theme-invariant (always dark)
        root.setProperty('--ux35-topbar-bg', '#161b22');
        root.setProperty('--ux35-topbar-fg', '#e6edf3');
        root.setProperty('--ux35-topbar-fg-muted', '#8b949e');
        root.setProperty('--ux35-topbar-border', '#30363d');

        // Force a synchronous style flush so paint does not wait for the next click
        void document.documentElement.offsetHeight;
        syncThemeIcon();
    }

    function reloadBrandingStylesheet(onReady) {
        var link = document.querySelector('link[href*="branding.css"]');
        if (!link) {
            if (onReady) onReady();
            return;
        }
        var url = new URL(link.href, window.location.origin);
        url.searchParams.set('v', String(Date.now()));
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            clearThemeInlineOverrides();
            void document.documentElement.offsetHeight;
            syncThemeIcon();
            if (onReady) onReady();
        }
        link.addEventListener('load', finish, { once: true });
        link.addEventListener('error', finish, { once: true });
        link.href = url.pathname + url.search;
        // Fallback if load already cached / does not fire
        setTimeout(finish, 400);
    }

    /**
     * Cycle visual theme: dark ↔ light.
     * Applies full solid token set immediately, then persists + reconciles branding.css.
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
                    if (window.BetterDesk.branding) {
                        window.BetterDesk.branding.themeMode = next;
                    }
                    reloadBrandingStylesheet();
                }
            }).catch(function () { /* keep local theme */ });
        }
    }

    function currentSidebarWidth() {
        var raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--ux35-sidebar-width').trim();
        var n = parseInt(raw, 10);
        return (n && !isNaN(n)) ? n : WIDTH_DEFAULT;
    }

    function initResize() {
        var handle = document.getElementById('ux35-sidebar-resize');
        if (!handle) return;

        var dragging = false;
        var startX = 0;
        var startWidth = WIDTH_DEFAULT;
        var pendingWidth = null;
        var rafId = 0;
        var lastApplied = 0;
        var activePointerId = null;

        function shellEl() {
            return document.getElementById('app');
        }

        function setResizing(on) {
            var shell = shellEl();
            if (shell) shell.classList.toggle('ux35-is-resizing', on);
            document.body.classList.toggle('ux35-is-resizing', on);
            handle.classList.toggle('active', on);
        }

        function flushWidth() {
            rafId = 0;
            if (pendingWidth == null) return;
            lastApplied = applySidebarWidth(pendingWidth);
            pendingWidth = null;
        }

        function scheduleWidth(px) {
            pendingWidth = px;
            if (!rafId) rafId = requestAnimationFrame(flushWidth);
        }

        function endDrag(persist) {
            if (!dragging) return;
            dragging = false;
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
            if (pendingWidth != null) {
                lastApplied = applySidebarWidth(pendingWidth);
                pendingWidth = null;
            }
            setResizing(false);
            if (activePointerId != null) {
                try {
                    if (handle.hasPointerCapture && handle.hasPointerCapture(activePointerId)) {
                        handle.releasePointerCapture(activePointerId);
                    }
                } catch (e) { /* ignore */ }
                activePointerId = null;
            }
            if (persist && lastApplied) {
                try { localStorage.setItem(STORAGE_WIDTH, String(lastApplied)); } catch (err) { /* ignore */ }
            }
        }

        handle.addEventListener('pointerdown', function (e) {
            if (MQ_DRAWER.matches) return;
            if (e.button != null && e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startWidth = currentSidebarWidth();
            lastApplied = startWidth;
            pendingWidth = null;
            activePointerId = e.pointerId;
            setResizing(true);
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            e.preventDefault();
        });

        handle.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            scheduleWidth(startWidth + (e.clientX - startX));
        });

        handle.addEventListener('pointerup', function () { endDrag(true); });
        handle.addEventListener('pointercancel', function () { endDrag(true); });
        handle.addEventListener('keydown', function (e) {
            if (MQ_DRAWER.matches) return;
            var current = currentSidebarWidth();
            var next = null;
            if (e.key === 'ArrowLeft') next = current - 10;
            else if (e.key === 'ArrowRight') next = current + 10;
            else if (e.key === 'Home') next = WIDTH_MIN;
            else if (e.key === 'End') next = WIDTH_MAX;
            if (next == null) return;
            e.preventDefault();
            lastApplied = applySidebarWidth(next);
            try { localStorage.setItem(STORAGE_WIDTH, String(lastApplied)); } catch (err) { /* ignore */ }
        });

        window.addEventListener('keydown', function (e) {
            if (!dragging) return;
            if (e.key === 'Escape') {
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = 0;
                }
                pendingWidth = null;
                applySidebarWidth(startWidth);
                lastApplied = startWidth;
                endDrag(false);
            }
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
            sidebar.addEventListener('transitionend', function (e) {
                if (e.propertyName !== 'transform') return;
                var shell = document.getElementById('app');
                clearDrawerAnimating(shell);
            });
        }

        window.addEventListener('keydown', function (e) {
            var shell = document.getElementById('app');
            if (!shell || !shell.classList.contains('ux35-drawer-open') || !MQ_DRAWER.matches) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                setDrawerOpen(false);
                return;
            }
            if (e.key !== 'Tab') return;
            var focusable = focusableIn(sidebar);
            if (!focusable.length) return;
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });

        function onMqChange() {
            if (!MQ_DRAWER.matches) {
                setDrawerOpen(false);
                restoreSidebarWidth();
            }
            syncDrawerAccessibility(false);
        }
        if (MQ_DRAWER.addEventListener) MQ_DRAWER.addEventListener('change', onMqChange);
        else if (MQ_DRAWER.addListener) MQ_DRAWER.addListener(onMqChange);
        syncDrawerAccessibility(false);
    }

    function initThemeBtn() {
        var btn = document.getElementById('ux35-theme-btn');
        if (btn) btn.addEventListener('click', cycleThemePreview);
        syncThemeIcon();
    }

    function initCompactActions() {
        var button = document.getElementById('ux35-actions-menu-btn');
        var list = document.getElementById('ux35-topbar-action-list');
        if (!button || !list) return;

        function setOpen(open) {
            list.classList.toggle('is-open', open);
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (!open && document.activeElement && list.contains(document.activeElement)) {
                button.focus({ preventScroll: true });
            }
        }

        button.addEventListener('click', function () {
            setOpen(!list.classList.contains('is-open'));
        });
        document.addEventListener('click', function (event) {
            if (!list.classList.contains('is-open')) return;
            if (event.target !== button && !button.contains(event.target) && !list.contains(event.target)) {
                setOpen(false);
            }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && list.classList.contains('is-open')) {
                event.preventDefault();
                setOpen(false);
            }
        });
        window.addEventListener('resize', function () {
            if (!window.matchMedia('(max-width: 767px)').matches) setOpen(false);
        });
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
        initThemeBtn();
        initCompactActions();
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
