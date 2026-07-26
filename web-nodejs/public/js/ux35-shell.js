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

    /**
     * Cycle visual preview: dark ↔ light.
     * Server-side themeMode (Settings → Branding) is the source of truth;
     * this only toggles local data-theme for immediate feedback when mode is dark/light.
     * Custom mode opens Settings branding.
     */
    function cycleThemePreview() {
        var mode = document.documentElement.getAttribute('data-theme-mode') || 'dark';
        if (mode === 'custom') {
            window.location.href = '/settings#branding';
            return;
        }
        var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        syncThemeIcon();
        // Persist via branding API when operator has permission (best-effort)
        if (window.BetterDesk && window.BetterDesk.csrfToken) {
            fetch('/api/settings/branding', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.BetterDesk.csrfToken
                },
                credentials: 'same-origin',
                body: JSON.stringify({ themeMode: next })
            }).then(function (res) {
                if (res.ok) {
                    document.documentElement.setAttribute('data-theme-mode', next);
                    var link = document.querySelector('link[href*="branding.css"]');
                    if (link) {
                        var url = new URL(link.href, window.location.origin);
                        url.searchParams.set('v', String(Date.now()));
                        link.href = url.pathname + url.search;
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
