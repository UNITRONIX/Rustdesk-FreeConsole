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

    function openDrawer() {
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

    function buildDrawerFromSidebar() {
        var body = document.getElementById('mobile-more-drawer-body');
        if (!body || body.dataset.built === '1') return;

        var panels = document.querySelectorAll('.sidebar-flyout-panel');
        if (!panels.length) return;

        var categoryTitles = {
            main: _('nav.main') || 'Main',
            management: _('nav.management') || 'Management',
            tools: _('nav.tools') || 'Tools',
            system: _('nav.system') || 'System',
            'server-mgmt': _('nav.server_management') || 'Server',
            commercialization: _('nav.commercialization') || 'Commercialization'
        };

        panels.forEach(function(panel) {
            var key = panel.getAttribute('data-panel');
            var links = panel.querySelectorAll('.sidebar-link');
            if (!links.length) return;

            var section = document.createElement('div');
            section.className = 'mobile-drawer-section';

            var title = document.createElement('div');
            title.className = 'mobile-drawer-section-title';
            title.textContent = categoryTitles[key] || key;
            section.appendChild(title);

            links.forEach(function(link) {
                var a = document.createElement('a');
                a.href = link.getAttribute('href') || '#';
                a.className = 'mobile-drawer-link';
                if (link.classList.contains('active')) a.classList.add('active');

                var icon = link.querySelector('.material-icons');
                if (icon) {
                    var ic = document.createElement('span');
                    ic.className = 'material-icons';
                    ic.textContent = icon.textContent;
                    a.appendChild(ic);
                }

                var text = link.querySelector('.sidebar-link-text');
                var span = document.createElement('span');
                span.textContent = text ? text.textContent.trim() : link.textContent.trim();
                a.appendChild(span);

                a.addEventListener('click', function() {
                    closeDrawer();
                });
                section.appendChild(a);
            });

            body.appendChild(section);
        });

        /* Settings + attestation from rail */
        var railLinks = document.querySelectorAll('.sidebar-rail-nav a.sidebar-rail-btn[href]');
        if (railLinks.length) {
            var railSection = document.createElement('div');
            railSection.className = 'mobile-drawer-section';
            var railTitle = document.createElement('div');
            railTitle.className = 'mobile-drawer-section-title';
            railTitle.textContent = _('nav.settings') || 'Settings';
            railSection.appendChild(railTitle);

            railLinks.forEach(function(link) {
                var a = document.createElement('a');
                a.href = link.getAttribute('href');
                a.className = 'mobile-drawer-link';
                if (link.classList.contains('active')) a.classList.add('active');
                var icon = link.querySelector('.material-icons');
                if (icon) {
                    var ic = document.createElement('span');
                    ic.className = 'material-icons';
                    ic.textContent = icon.textContent;
                    a.appendChild(ic);
                }
                var span = document.createElement('span');
                span.textContent = link.getAttribute('title') || link.textContent.trim();
                a.appendChild(span);
                a.addEventListener('click', closeDrawer);
                railSection.appendChild(a);
            });
            body.appendChild(railSection);
        }

        body.dataset.built = '1';
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
