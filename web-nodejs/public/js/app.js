/**
 * BetterDesk Console - Main Application
 */

(function() {
    'use strict';
    
    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', init);
    
    function init() {
        initSidebar();
        initNavbar();
        initLanguageSelector();
        initUserMenu();
        initRefreshButton();
        initRegistrationBadge();
        initPanelEvents();
    }

    /**
     * Classic rail sidebar — mobile overlay support
     */
    function initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (!sidebar) return;

        overlay?.addEventListener('click', () => {
            sidebar.classList.remove('open');
        });

        sidebar.querySelectorAll('.sidebar-link, .sidebar-rail-btn[href]').forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 1024) {
                    sidebar.classList.remove('open');
                }
            });
        });

        const mobileMenuBtn = document.getElementById('mobile-menu-btn');
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => {
                if (window.MobileNav && window.DeviceCapabilities?.isMobileShell()) {
                    window.MobileNav.openDrawer();
                    return;
                }
                sidebar.classList.toggle('open');
            });

            function checkMobile() {
                const useLegacy = window.innerWidth <= 1024
                    && !(window.DeviceCapabilities && window.DeviceCapabilities.isMobileShell());
                mobileMenuBtn.style.display = useLegacy ? 'flex' : 'none';
            }
            checkMobile();
            window.addEventListener('resize', Utils.debounce(checkMobile, 200));
        }
    }
    
    /**
     * Navbar functionality
     */
    function initNavbar() {
        // Dropdowns
        document.querySelectorAll('.lang-selector').forEach(selector => {
            const btn = selector.querySelector('button');
            const dropdown = selector.querySelector('.lang-dropdown');
            
            if (!btn || !dropdown) return;
            
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close other dropdowns
                document.querySelectorAll('.lang-dropdown.open').forEach(d => {
                    if (d !== dropdown) {
                        d.classList.remove('open');
                        d.parentElement?.querySelector('button')?.setAttribute('aria-expanded', 'false');
                    }
                });
                const open = !dropdown.classList.contains('open');
                dropdown.classList.toggle('open', open);
                btn.setAttribute('aria-expanded', String(open));
            });
        });
        
        // Close dropdowns on outside click
        document.addEventListener('click', () => {
            document.querySelectorAll('.lang-dropdown.open').forEach(d => {
                d.classList.remove('open');
                d.parentElement?.querySelector('button')?.setAttribute('aria-expanded', 'false');
            });
        });
    }
    
    /**
     * Language selector
     */
    function initLanguageSelector() {
        const langDropdown = document.getElementById('lang-dropdown');
        if (!langDropdown) return;
        
        langDropdown.querySelectorAll('.lang-option').forEach(option => {
            option.addEventListener('click', async (e) => {
                const lang = option.dataset.lang;
                if (lang) {
                    await window.changeLanguage(lang);
                }
            });
            option.addEventListener('keydown', async (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                const lang = option.dataset.lang;
                if (lang) {
                    await window.changeLanguage(lang);
                }
            });
        });
    }
    
    /**
     * User menu
     */
    function initUserMenu() {
        const changePasswordBtn = document.getElementById('change-password-btn');
        const logoutBtn = document.getElementById('logout-btn');
        
        changePasswordBtn?.addEventListener('click', () => {
            window.location.href = '/settings';
        });
        
        logoutBtn?.addEventListener('click', async () => {
            const confirmed = await Modal.confirm({
                title: _('auth.logout'),
                message: _('auth.logout_confirm'),
                confirmLabel: _('auth.logout'),
                danger: true
            });
            
            if (confirmed) {
                try {
                    await Utils.api('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/login';
                } catch (error) {
                    Notifications.error(_('errors.logout_failed'));
                }
            }
        });

        [changePasswordBtn, logoutBtn].filter(Boolean).forEach(btn => {
            btn.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                btn.click();
            });
        });
    }
    
    /**
     * Refresh button
     */
    function initRefreshButton() {
        const refreshBtn = document.getElementById('refresh-btn');
        if (!refreshBtn) return;
        
        refreshBtn.addEventListener('click', () => {
            // Dispatch custom event for page-specific refresh handlers
            window.dispatchEvent(new CustomEvent('app:refresh'));
            
            // Visual feedback
            const icon = refreshBtn.querySelector('.material-icons');
            if (icon) {
                icon.style.animation = 'spin 0.5s linear';
                setTimeout(() => {
                    icon.style.animation = '';
                }, 500);
            }
        });
    }
    
    // Add spin animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);

    /**
     * Periodically fetch pending registration count for sidebar badge.
     */
    function initRegistrationBadge() {
        const badges = () => [
            document.getElementById('reg-sidebar-badge'),
            document.getElementById('pending-count'),
        ].filter(Boolean);
        if (!badges().length) return;

        let badgeInterval = null;

        function renderRegistrationCount(count) {
            badges().forEach((badge) => {
                badge.textContent = String(count);
                badge.style.display = count > 0 ? '' : 'none';
            });
        }

        async function updateBadge() {
            try {
                const resp = await fetch('/api/registrations/count', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                });
                if (!resp.ok) {
                    if (resp.status === 401 && badgeInterval) {
                        clearInterval(badgeInterval);
                        badgeInterval = null;
                    }
                    return;
                }
                const data = await resp.json();
                const count = Number.isFinite(Number(data.count)) ? Number(data.count) : 0;
                renderRegistrationCount(Math.max(0, count));
            } catch (_) { /* silent */ }
        }

        updateBadge();
        badgeInterval = setInterval(updateBadge, 15000); // real-time fallback
    }

    /**
     * Subscribe once per page to events produced by the Go event bus and
     * Node.js LAN registration route. The notification center and the
     * registrations page consume the normalized browser event.
     */
    function initPanelEvents() {
        // The stream contains registration metadata, so only approvers need
        // to open it. The server repeats this authorization check during the
        // WebSocket upgrade.
        if (typeof WebSocket !== 'function' ||
            !document.getElementById('reg-sidebar-badge')) return;

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ws/panel-events`;
        let ws = null;
        let retryDelay = 3000;

        function connect() {
            try {
                ws = new WebSocket(wsUrl);
            } catch (_) {
                setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
                return;
            }

            ws.onopen = () => {
                retryDelay = 3000;
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'registration_pending' ||
                        data.type === 'registration_changed') {
                        window.dispatchEvent(new CustomEvent('registrations:pending-changed', {
                            detail: data,
                        }));
                    }
                    window.dispatchEvent(new CustomEvent('betterdesk:panel-event', {
                        detail: data,
                    }));
                } catch (_) {}
            };

            ws.onclose = () => {
                setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
            };

            ws.onerror = () => {
                ws.close();
            };
        }

        connect();
    }
    
})();
