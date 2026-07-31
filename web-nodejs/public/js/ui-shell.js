/**
 * BetterDesk Console — UI shell switcher (classic rail ↔ UX 3.5)
 * Persists choice in cookie bd_ui_shell and reloads.
 */
(function () {
    'use strict';

    var COOKIE = 'bd_ui_shell';
    var MAX_AGE_SEC = 365 * 24 * 60 * 60;

    function setCookie(value) {
        document.cookie = COOKIE + '=' + encodeURIComponent(value)
            + '; path=/; max-age=' + MAX_AGE_SEC + '; SameSite=Lax';
    }

    function switchTo(shell) {
        if (shell !== 'classic' && shell !== 'ux35') return;
        setCookie(shell);
        try { localStorage.setItem(COOKIE, shell); } catch (e) { /* ignore */ }
        var url = new URL(window.location.href);
        url.searchParams.set('ui', shell);
        window.location.href = url.pathname + url.search + url.hash;
    }

    function init() {
        if (window.BetterDesk && window.BetterDesk.embed) return;
        document.querySelectorAll('[data-ui-shell-switch]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                var target = btn.getAttribute('data-ui-shell-switch');
                if (!target) {
                    var current = (window.BetterDesk && window.BetterDesk.uiShell) || 'classic';
                    target = current === 'ux35' ? 'classic' : 'ux35';
                }
                switchTo(target);
            });
        });
    }

    window.UiShell = {
        switchTo: switchTo,
        current: function () {
            return (window.BetterDesk && window.BetterDesk.uiShell) || 'classic';
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
