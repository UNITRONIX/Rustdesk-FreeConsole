/**
 * BetterDesk Mobile Navigation — bottom bar + More drawer
 */
(function() {
    'use strict';

    var drawerOpen = false;
    var touchStartX = 0;

    function isMobileShell() {
        return window.DeviceCapabilities && window.DeviceCapabilities.isMobileShell();
    }

    function buildDrawerFromSidebar() {
        var body = document.getElementById('mobile-more-drawer-body');
        if (!body || body.dataset.built === '1') return;

        /* UX 3.5: full-list sidebar sections */
        var sections = document.querySelectorAll('.ux35-sidebar-section');
        if (sections.length) {
            sections.forEach(function(panel) {
                var links = panel.querySelectorAll('a.ux35-sidebar-item');
                if (!links.length) return;

                var section = document.createElement('div');
                section.className = 'mobile-drawer-section';

                var heading = panel.querySelector('.ux35-sidebar-heading');
                var title = document.createElement('div');
                title.className = 'mobile-drawer-section-title';
                title.textContent = heading ? heading.textContent.trim() : (panel.getAttribute('data-panel') || '');
                section.appendChild(title);

                links.forEach(function(link) {
                    var a = document.createElement('a');
                    a.href = link.getAttribute('href') || '#';
                    a.className = 'mobile-drawer-link';
                    if (link.classList.contains('active')) a.classList.add('active');
                    if (link.getAttribute('target')) a.target = link.getAttribute('target');

                    var icon = link.querySelector('.material-icons');
                    if (icon) {
                        var ic = document.createElement('span');
                        ic.className = 'material-icons';
                        ic.textContent = icon.textContent;
                        a.appendChild(ic);
                    }

                    var labels = link.querySelectorAll('span:not(.material-icons):not(.badge-sidebar):not(.ux35-sidebar-item-badge)');
                    var span = document.createElement('span');
                    span.textContent = labels.length ? labels[0].textContent.trim() : link.textContent.trim();
                    a.appendChild(span);

                    a.addEventListener('click', closeDrawer);
                    section.appendChild(a);
                });

                body.appendChild(section);
            });
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
        /* Prefer UX 3.5 sidebar drawer on narrow viewports */
        if (window.Ux35Shell && typeof window.Ux35Shell.openDrawer === 'function'
            && window.matchMedia('(max-width: 1099px)').matches) {
            window.Ux35Shell.openDrawer();
            return;
        }
        var drawer = document.getElementById('mobile-more-drawer');
        var btn = document.getElementById('mobile-more-btn');
        if (!drawer) return;
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        drawerOpen = true;
        document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
        if (window.Ux35Shell && typeof window.Ux35Shell.closeDrawer === 'function') {
            window.Ux35Shell.closeDrawer();
        }
        var drawer = document.getElementById('mobile-more-drawer');
        var btn = document.getElementById('mobile-more-btn');
        if (!drawer) return;
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        drawerOpen = false;
        if (isMobileShell()) {
            document.body.style.overflow = '';
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

        document.getElementById('mobile-more-btn')?.addEventListener('click', function() {
            if (drawerOpen) closeDrawer();
            else openDrawer();
        });

        document.getElementById('mobile-more-drawer-close')?.addEventListener('click', closeDrawer);
        document.getElementById('mobile-more-drawer-backdrop')?.addEventListener('click', closeDrawer);

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && drawerOpen) closeDrawer();
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
