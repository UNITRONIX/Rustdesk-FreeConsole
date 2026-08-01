/**
 * BetterDesk Help panel — supporters & project links
 * Shared by UX 3.5 (docked) and classic / Desktop Mode (slide-over).
 */
(function () {
    'use strict';

    var panel = null;
    var overlay = null;
    var closeBtn = null;
    var open = false;
    var wired = false;

    function t(key, fallback) {
        if (window.I18n && typeof window.I18n.t === 'function') {
            var v = window.I18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    function isUx35Desktop() {
        return !!(document.body && document.body.classList.contains('ux35-page')
            && window.matchMedia && window.matchMedia('(min-width: 1100px)').matches);
    }

    function shellEl() {
        return document.getElementById('app');
    }

    function setOpen(next) {
        if (!panel) return;
        open = !!next;
        panel.classList.toggle('is-open', open);
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');

        var shell = shellEl();
        if (shell) shell.classList.toggle('ux35-help-open', open);
        document.body.classList.toggle('ux35-help-open', open);

        if (overlay) {
            var useOverlay = open && !isUx35Desktop();
            if (useOverlay) {
                overlay.hidden = false;
                requestAnimationFrame(function () {
                    overlay.classList.add('is-visible');
                });
            } else {
                overlay.classList.remove('is-visible');
                overlay.hidden = true;
            }
        }

        if (open && closeBtn) {
            try { closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
    }

    function onKeydown(e) {
        if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
        }
    }

    function wireTriggers() {
        var ids = ['ux35-help-btn', 'sidebar-help-btn', 'topbar-help-btn', 'topnav-help'];
        ids.forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || el.dataset.helpPanelWired === '1') return;
            el.dataset.helpPanelWired = '1';
            el.addEventListener('click', function (e) {
                e.preventDefault();
                toggle();
            });
            var label = t('nav.help', 'Help');
            if (!el.getAttribute('title')) el.setAttribute('title', label);
            if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
        });
    }

    function init() {
        panel = document.getElementById('bd-help-panel');
        overlay = document.getElementById('bd-help-overlay');
        closeBtn = document.getElementById('bd-help-panel-close');
        if (!panel) return;

        if (!wired) {
            wired = true;
            if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
            if (overlay) overlay.addEventListener('click', function () { setOpen(false); });
            document.addEventListener('keydown', onKeydown);
            if (window.matchMedia) {
                var mq = window.matchMedia('(min-width: 1100px)');
                var onMq = function () {
                    if (!open) return;
                    // Re-apply overlay visibility when crossing the dock breakpoint
                    setOpen(true);
                };
                if (mq.addEventListener) mq.addEventListener('change', onMq);
                else if (mq.addListener) mq.addListener(onMq);
            }
        }

        wireTriggers();
    }

    function toggle() {
        if (!panel) init();
        if (!panel) return;
        setOpen(!open);
    }

    function openPanel() {
        if (!panel) init();
        setOpen(true);
    }

    function closePanel() {
        setOpen(false);
    }

    window.HelpPanel = {
        init: init,
        open: openPanel,
        close: closePanel,
        toggle: toggle,
        /** Re-scan for help buttons (Desktop Mode injects topnav later). */
        wireTriggers: wireTriggers
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
