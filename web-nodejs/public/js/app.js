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
                    if (d !== dropdown) d.classList.remove('open');
                });
                dropdown.classList.toggle('open');
            });
        });
        
        // Close dropdowns on outside click
        document.addEventListener('click', () => {
            document.querySelectorAll('.lang-dropdown.open').forEach(d => {
                d.classList.remove('open');
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
        const badge = document.getElementById('reg-sidebar-badge');
        if (!badge) return;

        let badgeInterval = null;

        async function updateBadge() {
            try {
                const resp = await fetch('/api/registrations/count');
                if (!resp.ok) {
                    if (resp.status === 401 && badgeInterval) {
                        clearInterval(badgeInterval);
                        badgeInterval = null;
                    }
                    return;
                }
                const data = await resp.json();
                const count = data.count || 0;
                badge.textContent = count;
                badge.style.display = count > 0 ? '' : 'none';
            } catch (_) { /* silent */ }
        }

        updateBadge();
        badgeInterval = setInterval(updateBadge, 30000); // every 30s
    }
    
})();
