/**
 * BetterDesk Mobile Navigation — bottom bar + More drawer
 */
(function() {
    'use strict';

    var drawerOpen = false;
    var touchStartX = 0;
    var drawerFocusOrigin = null;

    function isMobileShell() {
        return window.DeviceCapabilities && window.DeviceCapabilities.isMobileShell();
    }

    function isUx35Drawer() {
        return !!(window.Ux35Shell
            && window.matchMedia('(max-width: 1099px)').matches
            && document.body.classList.contains('ux35-page'));
    }

    function focusableIn(container) {
        if (!container) return [];
        return Array.prototype.slice.call(container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(function (el) { return el.offsetParent !== null; });
    }

    function buildDrawerFromSidebar() {
        var body = document.getElementById('mobile-more-drawer-body');
        if (!body || body.dataset.built === '1') return;

        /* UX 3.5 has a native sidebar drawer. Do not create a second,
           stale copy of the navigation for the same mobile control. */
        var sections = document.querySelectorAll('.ux35-sidebar-section');
        if (sections.length) {
            body.dataset.built = '1';
            return;
        }

        /* Legacy flyout fallback (should not run on UX 3.5) */
        var panels = document.querySelectorAll('.sidebar-flyout-panel');
        if (!panels.length) return;

        panels.forEach(function(panel) {
            var links = panel.querySelectorAll('.sidebar-link');
            if (!links.length) return;
            var section = document.createElement('div');
            section.className = 'mobile-drawer-section';
            var title = document.createElement('div');
            title.className = 'mobile-drawer-section-title';
            title.textContent = panel.getAttribute('data-panel') || '';
            section.appendChild(title);
            links.forEach(function(link) {
                var a = document.createElement('a');
                a.href = link.getAttribute('href') || '#';
                a.className = 'mobile-drawer-link';
                if (link.classList.contains('active')) a.classList.add('active');
                a.textContent = link.textContent.trim();
                a.addEventListener('click', closeDrawer);
                section.appendChild(a);
            });
            body.appendChild(section);
        });

        body.dataset.built = '1';
    }

    function openDrawer() {
        var btn = document.getElementById('mobile-more-btn');
        /* UX 3.5 owns its drawer state; mobile "More" becomes a second,
           equivalent trigger rather than maintaining a separate drawer. */
        if (isUx35Drawer()) {
            window.Ux35Shell.openDrawer();
            drawerOpen = true;
            if (btn) {
                btn.setAttribute('aria-expanded', 'true');
                btn.setAttribute('aria-controls', 'ux35-sidebar');
            }
            return;
        }
        var drawer = document.getElementById('mobile-more-drawer');
        if (!drawer) return;
        drawerFocusOrigin = document.activeElement;
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        drawerOpen = true;
        document.body.style.overflow = 'hidden';
        window.requestAnimationFrame(function () {
            var focusable = focusableIn(drawer);
            if (focusable.length) focusable[0].focus({ preventScroll: true });
        });
    }

    function closeDrawer() {
        var btn = document.getElementById('mobile-more-btn');
        if (isUx35Drawer()) {
            window.Ux35Shell.closeDrawer();
            drawerOpen = false;
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                btn.setAttribute('aria-controls', 'ux35-sidebar');
            }
            return;
        }
        var drawer = document.getElementById('mobile-more-drawer');
        if (!drawer) return;
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        drawerOpen = false;
        if (isMobileShell()) {
            document.body.style.overflow = '';
        }
        if (drawerFocusOrigin && document.contains(drawerFocusOrigin)) {
            drawerFocusOrigin.focus({ preventScroll: true });
            drawerFocusOrigin = null;
        }
    }

    function initSwipeGestures() {
        document.addEventListener('touchstart', function(e) {
            if (!isMobileShell()) return;
            touchStartX = e.touches[0].clientX;
        }, { passive: true });

        document.addEventListener('touchend', function(e) {
            if (!isMobileShell()) return;
            var dx = e.changedTouches[0].clientX - touchStartX;
            if (dx > 80 && touchStartX < 40 && !drawerOpen) {
                openDrawer();
            } else if (dx < -80 && drawerOpen) {
                closeDrawer();
            }
        }, { passive: true });
    }

    function init() {
        if (window.BetterDesk && window.BetterDesk.embed) return;

        buildDrawerFromSidebar();
        var moreBtn = document.getElementById('mobile-more-btn');
        if (moreBtn && isUx35Drawer()) moreBtn.setAttribute('aria-controls', 'ux35-sidebar');

        moreBtn?.addEventListener('click', function() {
            if (drawerOpen) closeDrawer();
            else openDrawer();
        });

        document.getElementById('mobile-more-drawer-close')?.addEventListener('click', closeDrawer);
        document.getElementById('mobile-more-drawer-backdrop')?.addEventListener('click', closeDrawer);

        document.addEventListener('keydown', function(e) {
            if (!drawerOpen || isUx35Drawer()) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeDrawer();
                return;
            }
            if (e.key !== 'Tab') return;
            var drawer = document.getElementById('mobile-more-drawer');
            var focusable = focusableIn(drawer);
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

        initSwipeGestures();

        window.addEventListener('resize', function() {
            if (!isMobileShell()) closeDrawer();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.MobileNav = {
        openDrawer: openDrawer,
        closeDrawer: closeDrawer
    };
})();
