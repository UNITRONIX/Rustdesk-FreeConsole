/**
 * BetterDesk Console - Desktop Mode (BETA)
 * Windows-like desktop environment with floating windows, taskbar, and app icons.
 * Available on viewports >= 1200px.
 * 
 * Status: BETA - Experimental feature, under active development.
 * Known limitations: iframe-based routing, mobile not supported, performance with many windows.
 */

(function() {
    'use strict';

    /**
     * Same-origin relative route for desktop iframe embeds.
     * Rejects protocol-relative, off-origin, and javascript/data URLs.
     */
    function sanitizeDesktopRoute(route) {
        if (typeof route !== 'string') return '/';
        const trimmed = route.trim();
        if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return '/';
        try {
            const parsed = new URL(trimmed, window.location.origin);
            if (parsed.origin !== window.location.origin) return '/';
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '/';
            return parsed.pathname + parsed.search;
        } catch (_) {
            return '/';
        }
    }

    // ============ Constants ============

    const MIN_WIDTH = 420;
    const MIN_HEIGHT = 300;
    const TASKBAR_HEIGHT = 10;  // slim taskbar height in px
    const BREAKPOINT = 1200;
    const STORAGE_KEY = 'betterdesk_desktop_mode';
    const STORAGE_WINS_KEY = 'betterdesk_desktop_wins';
    const CASCADE_OFFSET = 32;
    const STORAGE_FOLDABLE_AUTO = 'betterdesk_foldable_auto'; // Auto-switch on unfold


    // ============ State ============

    let active = false;
    let windows = new Map();
    let zCounter = 100;
    let focusedWindowId = null;
    let cascadeIndex = 0;
    let dragState = null;
    let resizeState = null;


    // ============ Windows 11 Snap System ============

    let _snapPreview = null;   // DOM element for blue snap zone preview
    let _snapTarget = null;    // {zone:'left'|'right'|'top-left'|...} active snap target
    let _snapPickerEl = null;  // Snap layout picker DOM (hover over maximize btn)
    let _layoutOverlayEl = null; // Dedicated layout overlay opened from desktop sidebar
    let _snapPickerTimeout = null;
    let _shakeOrigins = [];    // For Aero Shake detection

    // ---- Draggable Zone Borders state ----
    let _activeLayoutKey = null;        // Currently applied snap layout key
    let _activeZones = null;            // Array of zone objects (deep copy of layout zones) with mutable x/y/w/h
    let _zoneWinMap = [];               // Array mapping zone index → window id
    let _zoneDividers = [];             // DOM elements for zone border dividers
    let _zoneDragState = null;          // { dividerIdx, axis, startMouse, origZones }
    const ZONE_DIVIDER_HIT = 8;        // px hit area for divider drag
    const ZONE_MIN_FRACTION = 0.15;    // minimum zone width/height as fraction

    var SNAP_EDGE_THRESHOLD = 12;  // px from screen edge to trigger snap
    var SNAP_CORNER_SIZE = 80;     // px area in corners for quarter-snap

    var SNAP_LAYOUTS = [
        { key: '2col',     label: '50 / 50',     zones: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.5,h:1}] },
        { key: '2col-lr',  label: '60 / 40',     zones: [{x:0,y:0,w:.6,h:1},{x:.6,y:0,w:.4,h:1}] },
        { key: '3col',     label: '33 / 33 / 33', zones: [{x:0,y:0,w:.333,h:1},{x:.333,y:0,w:.334,h:1},{x:.667,y:0,w:.333,h:1}] },
        { key: '2x2',      label: '2 × 2',        zones: [{x:0,y:0,w:.5,h:.5},{x:.5,y:0,w:.5,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
        { key: '1+2',      label: '1 + 2',        zones: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
        { key: '1+3',      label: '1 + 3',        zones: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.5,h:.333},{x:.5,y:.333,w:.5,h:.334},{x:.5,y:.667,w:.5,h:.333}] }
    ];

    // Widget mode: 'windows' or 'widgets'
    let currentMode = 'widgets'; // Default to widgets mode
    const STORAGE_MODE = 'betterdesk_desktop_view_mode';

    // Foldable phone detection
    let isFoldableDevice = false;
    let devicePosture = 'unknown'; // 'continuous', 'folded', 'folded-over'

    // ============ Window Bounds Persistence ============

    /**
     * Save window position + size for a given app so it can be restored
     * when the user reopens the same app in a later session.
     */
    function saveWindowBounds(appId, x, y, width, height) {
        try {
            var all = JSON.parse(localStorage.getItem(STORAGE_WINS_KEY) || '{}');
            all[appId] = { x: x, y: y, w: width, h: height };
            localStorage.setItem(STORAGE_WINS_KEY, JSON.stringify(all));
        } catch (_) { /* quota exceeded — ignore */ }
    }

    function loadWindowBounds(appId) {
        try {
            var all = JSON.parse(localStorage.getItem(STORAGE_WINS_KEY) || '{}');
            return all[appId] || null;
        } catch (_) { return null; }
    }

    // ============ Apps Definition ============

    function getApps() {
        var t = typeof _ === 'function' ? _ : function(k) { return k; };
        var isAdmin = window.BetterDesk && window.BetterDesk.user &&
                      window.BetterDesk.user.role === 'admin';
        var apps = [
            // Main
            { id: 'dashboard',     icon: 'dashboard',        route: '/',              color: '#58a6ff',  name: t('nav.dashboard'),      category: 'main' },
            { id: 'devices',       icon: 'devices',          route: '/devices',       color: '#3fb950',  name: t('nav.devices'),        category: 'main' },
            { id: 'registrations', icon: 'how_to_reg',       route: '/registrations', color: '#79c0ff',  name: t('nav.registrations'),  category: 'main' },
            // Management
            { id: 'inventory',     icon: 'inventory_2',      route: '/inventory',     color: '#d2a8ff',  name: t('nav.inventory'),      category: 'management' },
            { id: 'tickets',       icon: 'confirmation_number', route: '/tickets',    color: '#ffa657',  name: t('nav.tickets'),        category: 'management' },
            { id: 'help-requests', icon: 'support_agent',    route: '/help-requests', color: '#79c0ff',  name: t('nav.help_requests'),  category: 'management' },
            { id: 'automation',    icon: 'smart_toy',        route: '/automation',    color: '#7ee787',  name: t('nav.automation'),     category: 'management' },
            { id: 'network',       icon: 'lan',              route: '/network',       color: '#56d4dd',  name: t('nav.network'),        category: 'management' },
            { id: 'activity',      icon: 'timeline',         route: '/activity',      color: '#ffd33d',  name: t('nav.activity'),       category: 'management' },
            { id: 'cdap',          icon: 'developer_board',  route: '/cdap',          color: '#a5d6ff',  name: t('nav.cdap'),           category: 'management' },
            // Tools
            { id: 'reports',       icon: 'assessment',       route: '/reports',       color: '#da7756',  name: t('nav.reports'),        category: 'tools' },
            { id: 'keys',          icon: 'vpn_key',          route: '/keys',          color: '#d29922',  name: t('nav.keys'),           category: 'tools' },
            { id: 'generator',     icon: 'build',            route: '/generator',     color: '#bc8cff',  name: t('nav.generator'),      category: 'tools' },
            { id: 'remote',        icon: 'connected_tv',     route: '/remote',        color: '#58a6ff',  name: t('nav.remote') || 'Remote Desktop', category: 'tools' },
            { id: 'toolkit',       icon: 'handyman',         route: '/toolkit',       color: '#f0883e',  name: t('nav.toolkit') || 'Toolkit', category: 'tools' },
            // Settings (always visible)
            { id: 'settings',      icon: 'settings',         route: '/settings',      color: '#8b949e',  name: t('nav.settings'),       category: 'settings' }
        ];

        if (isAdmin) {
            // Admin-only system apps
            var sysIdx = apps.findIndex(function(a) { return a.id === 'settings'; });
            apps.splice(sysIdx, 0,
                { id: 'tokens',        icon: 'token',          route: '/tokens',        color: '#e3b341', name: t('nav.tokens'),        category: 'system' },
                { id: 'organizations', icon: 'corporate_fare', route: '/organizations', color: '#79c0ff', name: t('nav.organizations'), category: 'system' },
                { id: 'dataguard',     icon: 'shield',         route: '/dataguard',     color: '#f85149', name: t('nav.dataguard'),     category: 'system' },
                { id: 'users',         icon: 'group',          route: '/users',         color: '#f778ba', name: t('nav.users'),         category: 'system' }
            );
        }

        return apps;
    }

    // ============ Initialization ============

    function init() {
        if (window.BetterDesk && window.BetterDesk.embed) return;
        
        // Initialize foldable device detection
        initFoldableDetection();
        
        if (window.innerWidth < BREAKPOINT && !isFoldableDevice) return;

        setupGlobalListeners();

        if (localStorage.getItem(STORAGE_KEY) === 'true' && window.innerWidth >= BREAKPOINT) {
            activate(true);
        }
    }

    // ============ Foldable Phone Detection ============

    function initFoldableDetection() {
        // Method 1: Device Posture API (Chrome 125+)
        if ('devicePosture' in navigator) {
            isFoldableDevice = true;
            devicePosture = navigator.devicePosture.type || 'unknown';
            
            navigator.devicePosture.addEventListener('change', function() {
                devicePosture = navigator.devicePosture.type;
                handlePostureChange(devicePosture);
            });
        }
        
        // Method 2: Screen Fold API (experimental)
        if ('getScreenFold' in window) {
            isFoldableDevice = true;
            window.getScreenFold().then(function(fold) {
                if (fold) {
                    fold.addEventListener('change', function() {
                        handleFoldChange(fold.angle, fold.posture);
                    });
                }
            }).catch(function() {});
        }
        
        // Method 3: CSS screen-spanning media query detection
        if (window.matchMedia) {
            var foldQuery = window.matchMedia('(screen-spanning: single-fold-vertical)');
            if (foldQuery.matches || foldQuery.media !== 'not all') {
                // Device supports screen-spanning query = likely foldable
                isFoldableDevice = checkFoldableByMediaQuery();
            }
            foldQuery.addEventListener('change', function(e) {
                if (e.matches) {
                    isFoldableDevice = true;
                    handlePostureChange('continuous');
                }
            });
        }
        
        // Method 4: Viewport size heuristic for known foldable aspect ratios
        // Samsung Galaxy Z Fold: ~880px unfolded inner width
        // Vivo X Fold: ~1080px unfolded inner width
        if (!isFoldableDevice) {
            isFoldableDevice = detectFoldableByAspectRatio();
        }
        
        // Log foldable detection status
        if (isFoldableDevice) {
            console.log('BetterDesk: Foldable device detected, posture:', devicePosture);
        }
    }
    
    function checkFoldableByMediaQuery() {
        return window.matchMedia('(horizontal-viewport-segments: 2)').matches ||
               window.matchMedia('(vertical-viewport-segments: 2)').matches ||
               window.matchMedia('(screen-spanning: single-fold-horizontal)').matches ||
               window.matchMedia('(screen-spanning: single-fold-vertical)').matches;
    }
    
    function detectFoldableByAspectRatio() {
        var w = window.innerWidth;
        var h = window.innerHeight;
        var ratio = w / h;
        
        // Foldable phones when unfolded typically have wider aspect ratios
        // Samsung Z Fold unfolded: ~1.0-1.2 (almost square)
        // Most regular phones: 0.4-0.6 (portrait) or 1.6-2.0 (landscape)
        
        // Consider device foldable if:
        // - Has touch support (mobile device)
        // - Inner width >= 700px (large for a phone)
        // - Aspect ratio between 0.8 and 1.4 (nearly square)
        var hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        var isLargeForPhone = w >= 700 && w <= 1400;
        var nearlySquare = ratio >= 0.8 && ratio <= 1.4;
        
        return hasTouch && isLargeForPhone && nearlySquare;
    }
    
    function handlePostureChange(posture) {
        devicePosture = posture;
        var autoSwitchEnabled = localStorage.getItem(STORAGE_FOLDABLE_AUTO) !== 'false';
        
        if (posture === 'continuous') {
            // Device is unfolded / flat
            if (autoSwitchEnabled && window.innerWidth >= BREAKPOINT) {
                activate(true);
            }
        } else if (posture === 'folded' || posture === 'folded-over') {
            // Device is folded
            if (autoSwitchEnabled && active) {
                deactivate(true);
            }
        }
    }
    
    function handleFoldChange(angle, posture) {
        // angle > 160° = nearly flat (unfolded)
        // angle < 90° = folded
        if (angle > 160) {
            handlePostureChange('continuous');
        } else if (angle < 90) {
            handlePostureChange('folded');
        }
    }
    
    function setFoldableAutoSwitch(enabled) {
        localStorage.setItem(STORAGE_FOLDABLE_AUTO, enabled ? 'true' : 'false');
    }
    
    function isFoldableAutoSwitchEnabled() {
        return localStorage.getItem(STORAGE_FOLDABLE_AUTO) !== 'false';
    }

    function setupGlobalListeners() {
        // Navbar toggle button
        var btn = document.getElementById('desktop-toggle-btn');
        if (btn) {
            btn.addEventListener('click', function() { toggle(); });
        }

        // Desktop context menu (right-click on desktop background)
        var shell = document.getElementById('desktop-shell');
        if (shell) {
            shell.addEventListener('contextmenu', function(e) {
                // Only trigger on desktop background, not on windows/widgets
                if (e.target.closest('.desktop-window') || e.target.closest('.desktop-taskbar') ||
                    e.target.closest('.desktop-widget') || e.target.closest('.desktop-icon')) return;
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY);
            });
        }

        // Global mouse events for drag/resize
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // Detect when focus enters an iframe (user clicked inside a window)
        window.addEventListener('blur', function() {
            if (!active) return;
            // Check which iframe received focus and focus that window
            setTimeout(function() {
                var activeEl = document.activeElement;
                if (activeEl && activeEl.tagName === 'IFRAME') {
                    var winEl = activeEl.closest('.desktop-window');
                    if (winEl && winEl.id) {
                        focusWindow(winEl.id);
                    }
                }
            }, 0);
        });

        // Responsive: deactivate if viewport shrinks below breakpoint
        // and re-clamp windows that may be offscreen after resize
        var onResize = Utils.debounce(function() {
            if (active && window.innerWidth < BREAKPOINT) {
                deactivate(true);
                return;
            }
            if (active) clampAllWindows();
        }, 200);
        window.addEventListener('resize', onResize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onResize);
        }
    }

    // ============ Activate / Deactivate ============

    function activate(skipAnimation) {
        if (active) return;
        active = true;
        localStorage.setItem(STORAGE_KEY, 'true');
        // Set HTTP cookie so server can detect desktop mode for login page
        document.cookie = 'betterdesk_desktop_mode=true;path=/;max-age=31536000;SameSite=Lax';

        document.body.classList.add('desktop-active');
        if (!skipAnimation) {
            document.body.classList.add('desktop-entering');
            setTimeout(function() {
                document.body.classList.remove('desktop-entering');
            }, 350);
        }

        // Force dark theme (theme switching removed — conflicts with branding)
        document.documentElement.classList.remove('desktop-theme-light');
        document.documentElement.classList.add('desktop-theme-dark');

        // Desktop icons removed — apps open via drawer/shortcuts only
        initTopbar();
        initAppDrawer();

        // Restore saved mode or default to widgets
        currentMode = localStorage.getItem(STORAGE_MODE) || 'widgets';
        applyMode(currentMode);
    }

    function deactivate(silent) {
        if (!active) return;
        active = false;
        localStorage.setItem(STORAGE_KEY, 'false');
        // Clear HTTP cookie
        document.cookie = 'betterdesk_desktop_mode=;path=/;max-age=0;SameSite=Lax';

        // Destroy widget mode
        if (window.DesktopWidgets) {
            window.DesktopWidgets.destroy();
            window.DesktopWidgets.removeAddButton();
        }

        destroyTopbar();
        closeAppDrawer();

        // Close all windows
        windows.forEach(function(win) {
            removeWindowDOM(win.id, true);
        });
        windows.clear();
        focusedWindowId = null;
        cascadeIndex = 0;
        clearActiveZoneLayout();

        document.body.classList.remove('desktop-active', 'desktop-entering', 'desktop-mode-widgets', 'desktop-mode-windows', 'desktop-mode-unified');
        clearDesktopIcons();
        clearTaskbar();

        if (!silent) {
            // Reload to restore console view properly
            window.location.reload();
        }
    }

    function toggle() {
        if (active) {
            deactivate();
        } else {
            activate();
        }
    }

    // ============ Desktop Icons ============

    function renderDesktopIcons() {
        var container = document.getElementById('desktop-icons');
        if (!container) return;
        container.innerHTML = '';

        var apps = getApps();
        apps.forEach(function(app, index) {
            var el = document.createElement('div');
            el.className = 'desktop-icon';
            el.setAttribute('data-app', app.id);
            el.style.animationDelay = (index * 0.05) + 's';

            var imgWrap = document.createElement('div');
            imgWrap.className = 'desktop-icon-img';
            imgWrap.style.background = sanitizeAppColor(app.color);
            imgWrap.appendChild(createMaterialIconSpan(app.icon));

            var label = document.createElement('span');
            label.className = 'desktop-icon-label';
            label.textContent = app.name || '';

            el.appendChild(imgWrap);
            el.appendChild(label);

            el.addEventListener('dblclick', function() {
                openApp(app);
            });

            container.appendChild(el);
        });
    }

    function clearDesktopIcons() {
        var container = document.getElementById('desktop-icons');
        if (container) container.innerHTML = '';
    }

    // ============ Desktop Context Menu ============

    function showContextMenu(x, y) {
        var menu = document.getElementById('desktop-context-menu');
        if (!menu) return;

        // Position menu, ensuring it stays within viewport
        var area = getDesktopArea();
        var mw = 200, mh = 160; // approximate menu size
        var posX = Math.min(x, area.width - mw);
        var posY = Math.min(y, area.y + area.height - mh);

        menu.style.left = posX + 'px';
        menu.style.top = posY + 'px';
        menu.style.display = 'block';

        function closeCtx(e) {
            if (!menu.contains(e.target)) {
                menu.style.display = 'none';
                document.removeEventListener('click', closeCtx);
            }
        }
        setTimeout(function() {
            document.addEventListener('click', closeCtx);
        }, 10);

        // Context menu actions
        menu.querySelectorAll('.ctx-item').forEach(function(item) {
            item.onclick = function() {
                menu.style.display = 'none';
                var action = item.getAttribute('data-action');
                if (action === 'wallpaper' && window.DesktopWidgets) {
                    window.DesktopWidgets.openWallpaperPicker();
                } else if (action === 'layout') {
                    openLayoutOverlay();
                } else if (action === 'refresh') {
                    if (window.DesktopWidgets) window.DesktopWidgets.refreshAll();
                } else if (action === 'exit') {
                    deactivate();
                }
            };
        });
    }

    // ============ Taskbar Auto-Hide ============

    function updateTaskbarVisibility() {
        var taskbar = document.getElementById('desktop-taskbar');
        if (!taskbar) return;

        var shouldHide = windows.size === 0;
        var wasHidden = taskbar.classList.contains('taskbar-hidden');

        taskbar.classList.toggle('taskbar-hidden', shouldHide);

        if (wasHidden !== shouldHide) {
            requestAnimationFrame(function() {
                if (active) clampAllWindows();
            });
        }
    }

    // ============ Window Management ============

    function openApp(app) {
        // Check if window already open for this app
        var existingId = null;
        windows.forEach(function(win, id) {
            if (win.appId === app.id) existingId = id;
        });

        if (existingId) {
            var win = windows.get(existingId);
            if (win.minimized) {
                restoreWindow(existingId);
            }
            focusWindow(existingId);
            return;
        }

        createWindow(app);
    }

    function createWindow(app) {
        var id = 'win-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);

        // Try to restore saved position + size for this app
        var saved = loadWindowBounds(app.id);
        var area = getDesktopArea();
        var width, height, x, y;

        if (saved && saved.w > 0 && saved.h > 0) {
            width  = Math.min(saved.w, area.width);
            height = Math.min(saved.h, area.height);
            x = Math.max(area.x, Math.min(saved.x, area.x + area.width - 80));
            y = Math.max(area.y, Math.min(saved.y, area.y + area.height - 32));
        } else {
            // Default cascading position
            width  = Math.min(960, area.width - 80);
            height = Math.min(640, area.height - 80);
            x = area.x + 60 + (cascadeIndex * CASCADE_OFFSET) % (area.width - width - 60);
            y = area.y + 40 + (cascadeIndex * CASCADE_OFFSET) % (area.height - height - 40);
        }
        cascadeIndex++;

        var win = {
            id: id,
            appId: app.id,
            app: app,
            x: x,
            y: y,
            width: width,
            height: height,
            minimized: false,
            maximized: false,
            prevBounds: null,
            zIndex: ++zCounter
        };

        windows.set(id, win);
        renderWindow(win);
        focusWindow(id);
        updateTaskbar();
    }

    function renderWindow(win) {
        var container = document.getElementById('desktop-windows');
        if (!container) return;

        var el = document.createElement('div');
        el.className = 'desktop-window focused';
        el.id = win.id;
        el.style.left = win.x + 'px';
        el.style.top = win.y + 'px';
        el.style.width = win.width + 'px';
        el.style.height = win.height + 'px';
        el.style.zIndex = win.zIndex;

        var t = typeof _ === 'function' ? _ : function(k) { return k; };

        var titlebar = document.createElement('div');
        titlebar.className = 'window-titlebar';
        titlebar.setAttribute('data-win', win.id);

        var iconWrap = document.createElement('div');
        iconWrap.className = 'window-titlebar-icon';
        iconWrap.style.background = sanitizeAppColor(win.app.color);
        iconWrap.appendChild(createMaterialIconSpan(win.app.icon));

        var titleText = document.createElement('div');
        titleText.className = 'window-titlebar-text';
        titleText.textContent = win.app.name || '';

        var controls = document.createElement('div');
        controls.className = 'window-titlebar-controls';
        controls.appendChild(createWindowCtrlBtn('minimize', 'minimize', t('desktop.minimize')));
        controls.appendChild(createWindowCtrlBtn('maximize', 'maximize', t('desktop.maximize')));
        controls.appendChild(createWindowCtrlBtn('close', 'close', t('desktop.close')));

        titlebar.appendChild(iconWrap);
        titlebar.appendChild(titleText);
        titlebar.appendChild(controls);

        var content = document.createElement('div');
        content.className = 'window-content';

        var loading = document.createElement('div');
        loading.className = 'window-loading';
        var spinner = document.createElement('div');
        spinner.className = 'window-loading-spinner';
        var loadingText = document.createElement('div');
        loadingText.className = 'window-loading-text';
        loadingText.textContent = t('desktop.loading');
        loading.appendChild(spinner);
        loading.appendChild(loadingText);

        var iframe = document.createElement('iframe');
        iframe.src = sanitizeDesktopRoute(win.app.route) + '?embed=1';
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals');
        iframe.setAttribute('loading', 'lazy');

        content.appendChild(loading);
        content.appendChild(iframe);

        el.appendChild(titlebar);
        el.appendChild(content);

        ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function(dir) {
            var edge = document.createElement('div');
            edge.className = 'window-edge edge-' + dir;
            edge.setAttribute('data-dir', dir);
            el.appendChild(edge);
        });

        // Event: focus on click
        el.addEventListener('mousedown', function(e) {
            if (!e.target.closest('.window-ctrl-btn')) {
                focusWindow(win.id);
            }
        });

        // Event: title bar controls
        el.querySelectorAll('.window-ctrl-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var action = btn.getAttribute('data-action');
                if (action === 'minimize') minimizeWindow(win.id);
                else if (action === 'maximize') toggleMaximize(win.id);
                else if (action === 'close') closeWindow(win.id);
            });
        });

        // Event: drag via title bar
        var titlebar = el.querySelector('.window-titlebar');
        titlebar.addEventListener('mousedown', function(e) {
            if (e.target.closest('.window-ctrl-btn')) return;
            startDrag(win.id, e);
        });

        // Event: double-click title bar to maximize
        titlebar.addEventListener('dblclick', function(e) {
            if (e.target.closest('.window-ctrl-btn')) return;
            toggleMaximize(win.id);
        });

        // Event: snap layout picker on maximize button hover (Windows 11 style)
        var maxBtn = el.querySelector('.maximize-btn');
        if (maxBtn) {
            var _hoverTimeout = null;
            maxBtn.addEventListener('mouseenter', function() {
                _hoverTimeout = setTimeout(function() {
                    showSnapPicker(win.id, maxBtn);
                }, 350);
            });
            maxBtn.addEventListener('mouseleave', function() {
                clearTimeout(_hoverTimeout);
            });
        }

        // Event: resize edges/corners
        el.querySelectorAll('.window-edge').forEach(function(edge) {
            edge.addEventListener('mousedown', function(e) {
                e.stopPropagation();
                startResize(win.id, e, edge.getAttribute('data-dir'));
            });
        });

        // Event: iframe loaded
        var iframe = el.querySelector('iframe');
        var loadingOverlay = el.querySelector('.window-loading');
        iframe.addEventListener('load', function() {
            loadingOverlay.classList.add('hidden');
        });

        container.appendChild(el);
    }

    function closeWindow(id) {
        var win = windows.get(id);
        // Persist position before removing
        if (win && !win.maximized) {
            saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
        }

        var el = document.getElementById(id);
        if (!el) {
            windows.delete(id);
            updateTaskbar();
            return;
        }

        el.classList.add('closing');
        el.addEventListener('animationend', function() {
            removeWindowDOM(id, false);
        }, { once: true });
    }

    function removeWindowDOM(id, immediate) {
        var el = document.getElementById(id);
        if (el) {
            // Destroy iframe to free memory
            var iframe = el.querySelector('iframe');
            if (iframe) iframe.src = 'about:blank';
            el.remove();
        }
        windows.delete(id);

        if (focusedWindowId === id) {
            focusedWindowId = null;
            // Focus next topmost window
            var topWin = null;
            windows.forEach(function(w) {
                if (!w.minimized && (!topWin || w.zIndex > topWin.zIndex)) {
                    topWin = w;
                }
            });
            if (topWin) focusWindow(topWin.id);
        }

        updateTaskbar();
    }

    function minimizeWindow(id) {
        var win = windows.get(id);
        if (!win) return;
        win.minimized = true;

        var el = document.getElementById(id);
        if (el) {
            el.classList.add('minimizing');
            el.addEventListener('animationend', function() {
                el.style.display = 'none';
                el.classList.remove('minimizing');
            }, { once: true });
        }

        if (focusedWindowId === id) {
            focusedWindowId = null;
            // Focus next topmost visible window
            var topWin = null;
            windows.forEach(function(w) {
                if (!w.minimized && w.id !== id && (!topWin || w.zIndex > topWin.zIndex)) {
                    topWin = w;
                }
            });
            if (topWin) focusWindow(topWin.id);
        }

        updateTaskbar();
    }

    function restoreWindow(id) {
        var win = windows.get(id);
        if (!win) return;
        win.minimized = false;

        var el = document.getElementById(id);
        if (el) {
            el.style.display = '';
            el.style.animation = 'none';
            // Force reflow
            el.offsetHeight;
            el.style.animation = '';
            el.classList.remove('minimizing');
            // Re-trigger open animation
            el.style.animation = 'windowOpen 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
        }

        focusWindow(id);
        updateTaskbar();
    }

    function toggleMaximize(id) {
        var win = windows.get(id);
        if (!win) return;

        var el = document.getElementById(id);
        if (!el) return;

        if (win.maximized) {
            // Restore
            win.maximized = false;
            el.classList.remove('maximized');
            if (win.prevBounds) {
                el.style.left = win.prevBounds.x + 'px';
                el.style.top = win.prevBounds.y + 'px';
                el.style.width = win.prevBounds.width + 'px';
                el.style.height = win.prevBounds.height + 'px';
                win.x = win.prevBounds.x;
                win.y = win.prevBounds.y;
                win.width = win.prevBounds.width;
                win.height = win.prevBounds.height;
            }
        } else {
            // Maximize
            win.prevBounds = { x: win.x, y: win.y, width: win.width, height: win.height };
            win.maximized = true;
            var area = getDesktopArea();
            el.classList.add('maximized');
            el.style.left = area.x + 'px';
            el.style.top = area.y + 'px';
            el.style.width = area.width + 'px';
            el.style.height = area.height + 'px';
            win.x = area.x;
            win.y = area.y;
            win.width = area.width;
            win.height = area.height;
        }

        // Update maximize button icon
        var maxBtn = el.querySelector('.maximize-btn .material-icons');
        if (maxBtn) {
            maxBtn.textContent = win.maximized ? 'filter_none' : 'crop_square';
        }
    }

    function focusWindow(id) {
        if (focusedWindowId === id) return;

        // Unfocus previous
        if (focusedWindowId) {
            var prevEl = document.getElementById(focusedWindowId);
            if (prevEl) prevEl.classList.remove('focused');
        }

        focusedWindowId = id;
        var win = windows.get(id);
        if (!win) return;

        win.zIndex = ++zCounter;
        var el = document.getElementById(id);
        if (el) {
            el.style.zIndex = win.zIndex;
            el.classList.add('focused');
            // Disable pointer events on iframe when not focused for drag/resize
        }

        updateTaskbar();
    }

    // ============ Drag ============

    function startDrag(winId, e) {
        var win = windows.get(winId);
        if (!win) return;

        // If maximized, un-maximize on drag start (Windows 11 behavior)
        if (win.maximized) {
            var el = document.getElementById(winId);
            var pct = e.clientX / window.innerWidth; // mouse % across screen
            win.maximized = false;
            if (el) el.classList.remove('maximized');
            if (win.prevBounds) {
                win.width = win.prevBounds.width;
                win.height = win.prevBounds.height;
                win.x = e.clientX - win.width * pct;
                win.y = e.clientY - 20;
                if (el) {
                    el.style.width = win.width + 'px';
                    el.style.height = win.height + 'px';
                    el.style.left = win.x + 'px';
                    el.style.top = win.y + 'px';
                }
                var maxIcon = el && el.querySelector('.maximize-btn .material-icons');
                if (maxIcon) maxIcon.textContent = 'crop_square';
            }
            win.prevBounds = null;
        }

        e.preventDefault();
        focusWindow(winId);

        _shakeOrigins = []; // Reset shake detection

        dragState = {
            winId: winId,
            startX: e.clientX,
            startY: e.clientY,
            origX: win.x,
            origY: win.y
        };

        disableIframePointerEvents();
        document.body.style.cursor = 'move';
    }

    var _rafPending = false;
    var _lastMoveEvent = null;

    function handleMouseMove(e) {
        _lastMoveEvent = e;
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(function () {
            _rafPending = false;
            var ev = _lastMoveEvent;
            if (!ev) return;
            _handleMouseMoveInner(ev);
        });
    }

    function _handleMouseMoveInner(e) {
        if (dragState) {
            var dx = e.clientX - dragState.startX;
            var dy = e.clientY - dragState.startY;
            var win = windows.get(dragState.winId);
            if (!win) return;

            var area = getDesktopArea();
            var newX = dragState.origX + dx;
            var newY = dragState.origY + dy;

            // Clamp: keep at least 80px of title bar visible horizontally
            newX = Math.max(-win.width + 80, Math.min(newX, area.width - 80));
            // Clamp: stay within desktop area (above taskbar, below topnav)
            newY = Math.max(area.y, Math.min(newY, area.y + area.height - 32));

            win.x = newX;
            win.y = newY;

            var el = document.getElementById(dragState.winId);
            if (el) {
                el.style.left = win.x + 'px';
                el.style.top = win.y + 'px';
            }

            // Windows 11 snap zone detection during drag
            var zone = detectSnapZone(e.clientX, e.clientY);
            if (zone) {
                showSnapPreview(zone);
            } else {
                removeSnapPreview();
            }

            // Aero Shake detection
            if (detectAeroShake(dragState.winId, e.clientX, e.clientY)) {
                aeroShake(dragState.winId);
            }
        }

        if (resizeState) {
            var dx = e.clientX - resizeState.startX;
            var dy = e.clientY - resizeState.startY;
            var win = windows.get(resizeState.winId);
            if (!win) return;

            var dir = resizeState.dir;
            var newX = win.x, newY = win.y;
            var newW = win.width, newH = win.height;
            var area = getDesktopArea();

            if (dir.indexOf('e') !== -1) {
                newW = Math.max(MIN_WIDTH, Math.min(resizeState.origW + dx, area.width - newX));
            }
            if (dir.indexOf('w') !== -1) {
                var dw = resizeState.origW - dx;
                if (dw >= MIN_WIDTH) {
                    newW = dw;
                    newX = Math.max(0, resizeState.origX + dx);
                }
            }
            if (dir.indexOf('s') !== -1) {
                newH = Math.max(MIN_HEIGHT, Math.min(resizeState.origH + dy, area.y + area.height - newY));
            }
            if (dir === 'n' || dir === 'ne' || dir === 'nw') {
                var dh = resizeState.origH - dy;
                if (dh >= MIN_HEIGHT) {
                    newH = dh;
                    newY = Math.max(0, resizeState.origY + dy);
                }
            }

            win.x = newX;
            win.y = newY;
            win.width = newW;
            win.height = newH;

            var el = document.getElementById(resizeState.winId);
            if (el) {
                el.style.left = newX + 'px';
                el.style.top = newY + 'px';
                el.style.width = newW + 'px';
                el.style.height = newH + 'px';
            }
        }
    }

    function handleMouseUp(e) {
        if (dragState) {
            var win = windows.get(dragState.winId);
            // Apply snap zone if active
            if (_snapTarget && win) {
                applySnap(dragState.winId, _snapTarget);
            } else if (win && !win.maximized) {
                saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
                // User manually moved a window — clear snap zone layout tracking
                if (win.snappedZone) {
                    win.snappedZone = null;
                    clearActiveZoneLayout();
                }
            }
            removeSnapPreview();
        }
        if (resizeState) {
            var win = windows.get(resizeState.winId);
            if (win && !win.maximized) {
                saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
            }
        }
        if (dragState || resizeState) {
            enableIframePointerEvents();
            document.body.style.cursor = '';
        }
        dragState = null;
        resizeState = null;
    }

    /**
     * Re-clamp all windows within viewport bounds (e.g. after browser resize).
     */
    function clampAllWindows() {
        var area = getDesktopArea();
        windows.forEach(function(win) {
            var el = document.getElementById(win.id);
            if (!el) return;

            if (win.maximized) {
                // Re-maximize to new area bounds
                win.x = area.x;
                win.y = area.y;
                win.width = area.width;
                win.height = area.height;
                el.style.left = area.x + 'px';
                el.style.top = area.y + 'px';
                el.style.width = area.width + 'px';
                el.style.height = area.height + 'px';
                return;
            }

            // Keep at least 80px visible horizontally, stay within area vertically
            var clampedX = Math.max(-win.width + 80, Math.min(win.x, area.width - 80));
            var clampedY = Math.max(area.y, Math.min(win.y, area.y + area.height - 32));
            if (clampedX !== win.x || clampedY !== win.y) {
                win.x = clampedX;
                win.y = clampedY;
                el.style.left = win.x + 'px';
                el.style.top = win.y + 'px';
            }

            // Shrink window if it exceeds available area
            if (win.width > area.width) {
                win.width = area.width;
                el.style.width = win.width + 'px';
            }
            if (win.y + win.height > area.y + area.height) {
                win.height = Math.max(MIN_HEIGHT, area.y + area.height - win.y);
                el.style.height = win.height + 'px';
            }
        });
    }

    // ============ Resize ============

    var cursorMap = { n:'ns-resize', s:'ns-resize', e:'ew-resize', w:'ew-resize',
                       ne:'nesw-resize', sw:'nesw-resize', nw:'nwse-resize', se:'nwse-resize' };

    function startResize(winId, e, dir) {
        var win = windows.get(winId);
        if (!win || win.maximized) return;

        e.preventDefault();
        focusWindow(winId);

        resizeState = {
            winId: winId,
            dir: dir || 'se',
            startX: e.clientX,
            startY: e.clientY,
            origW: win.width,
            origH: win.height,
            origX: win.x,
            origY: win.y
        };

        disableIframePointerEvents();
        document.body.style.cursor = cursorMap[dir] || 'se-resize';
    }

    // ============ Iframe Pointer Control ============

    function disableIframePointerEvents() {
        document.querySelectorAll('.desktop-window iframe').forEach(function(iframe) {
            iframe.style.pointerEvents = 'none';
        });
    }

    function enableIframePointerEvents() {
        document.querySelectorAll('.desktop-window iframe').forEach(function(iframe) {
            iframe.style.pointerEvents = '';
        });
    }

    // ============ Snap Zone Detection & Preview ============

    function detectSnapZone(clientX, clientY) {
        var area = getDesktopArea();
        var nearLeft   = clientX <= SNAP_EDGE_THRESHOLD;
        var nearRight  = clientX >= area.width - SNAP_EDGE_THRESHOLD;
        var nearTop    = clientY <= area.y + SNAP_EDGE_THRESHOLD;
        var nearBottom = clientY >= area.y + area.height - SNAP_EDGE_THRESHOLD;
        var inCornerTop = clientY < area.y + SNAP_CORNER_SIZE;
        var inCornerBottom = clientY > area.y + area.height - SNAP_CORNER_SIZE;

        if (nearTop && !nearLeft && !nearRight) return 'maximize';
        if (nearLeft && inCornerTop)   return 'top-left';
        if (nearLeft && inCornerBottom) return 'bottom-left';
        if (nearLeft)                   return 'left';
        if (nearRight && inCornerTop)  return 'top-right';
        if (nearRight && inCornerBottom) return 'bottom-right';
        if (nearRight)                  return 'right';
        return null;
    }

    function getSnapBounds(zone) {
        var area = getDesktopArea();
        var PAD = 3;
        switch (zone) {
            case 'left':         return { x: area.x + PAD, y: area.y + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: area.height - PAD * 2 };
            case 'right':        return { x: area.x + Math.floor(area.width / 2) + PAD, y: area.y + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: area.height - PAD * 2 };
            case 'top-left':     return { x: area.x + PAD, y: area.y + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: Math.floor(area.height / 2) - PAD * 2 };
            case 'top-right':    return { x: area.x + Math.floor(area.width / 2) + PAD, y: area.y + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: Math.floor(area.height / 2) - PAD * 2 };
            case 'bottom-left':  return { x: area.x + PAD, y: area.y + Math.floor(area.height / 2) + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: Math.floor(area.height / 2) - PAD * 2 };
            case 'bottom-right': return { x: area.x + Math.floor(area.width / 2) + PAD, y: area.y + Math.floor(area.height / 2) + PAD, w: Math.floor(area.width / 2) - PAD * 2, h: Math.floor(area.height / 2) - PAD * 2 };
            case 'maximize':     return { x: area.x + PAD, y: area.y + PAD, w: area.width - PAD * 2, h: area.height - PAD * 2 };
            default: return null;
        }
    }

    function showSnapPreview(zone) {
        if (_snapTarget && _snapTarget === zone) return;
        removeSnapPreview();
        _snapTarget = zone;

        var bounds = getSnapBounds(zone);
        if (!bounds) return;

        _snapPreview = document.createElement('div');
        _snapPreview.className = 'desktop-snap-preview';
        _snapPreview.style.left   = bounds.x + 'px';
        _snapPreview.style.top    = bounds.y + 'px';
        _snapPreview.style.width  = bounds.w + 'px';
        _snapPreview.style.height = bounds.h + 'px';

        var container = document.getElementById('desktop-windows') || document.body;
        container.appendChild(_snapPreview);

        // Trigger animation
        requestAnimationFrame(function() {
            if (_snapPreview) _snapPreview.classList.add('visible');
        });
    }

    function removeSnapPreview() {
        _snapTarget = null;
        if (_snapPreview) {
            _snapPreview.remove();
            _snapPreview = null;
        }
    }

    function applySnap(winId, zone) {
        var win = windows.get(winId);
        if (!win) return;

        var bounds = getSnapBounds(zone);
        if (!bounds) return;

        // Save original bounds for un-snap (like Win11 restore)
        if (!win.prevBounds) {
            win.prevBounds = { x: win.x, y: win.y, width: win.width, height: win.height };
        }

        win.x = bounds.x;
        win.y = bounds.y;
        win.width = bounds.w;
        win.height = bounds.h;
        win.maximized = (zone === 'maximize');
        win.snappedZone = zone;

        var el = document.getElementById(winId);
        if (el) {
            el.style.transition = 'left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease';
            el.style.left   = win.x + 'px';
            el.style.top    = win.y + 'px';
            el.style.width  = win.width + 'px';
            el.style.height = win.height + 'px';

            if (zone === 'maximize') el.classList.add('maximized');
            else el.classList.remove('maximized');

            // Update maximize icon
            var maxIcon = el.querySelector('.maximize-btn .material-icons');
            if (maxIcon) maxIcon.textContent = (zone === 'maximize') ? 'filter_none' : 'crop_square';

            // Remove transition after animation
            setTimeout(function() { el.style.transition = ''; }, 250);
        }

        saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
    }

    // ============ Snap Layout Picker (Maximize Button Hover) ============

    function showSnapPicker(winId, anchorEl) {
        hideSnapPicker();

        var area = getDesktopArea();
        var rect = anchorEl.getBoundingClientRect();

        _snapPickerEl = document.createElement('div');
        _snapPickerEl.className = 'snap-layout-picker';

        var html = '<div class="snap-picker-title">Snap Layouts</div><div class="snap-picker-grid">';

        SNAP_LAYOUTS.forEach(function(layout) {
            html += '<button class="snap-picker-option" data-key="' + layout.key + '" title="' + escapeAttr(layout.label) + '">';
            html += '<div class="snap-picker-preview">';
            layout.zones.forEach(function(z) {
                html += '<div class="snap-picker-zone" style="' +
                    'left:' + (z.x * 100) + '%;top:' + (z.y * 100) + '%;' +
                    'width:' + (z.w * 100) + '%;height:' + (z.h * 100) + '%"></div>';
            });
            html += '</div></button>';
        });

        html += '</div>';
        _snapPickerEl.innerHTML = html;

        // Position below the maximize button
        _snapPickerEl.style.position = 'fixed';
        _snapPickerEl.style.left = Math.max(4, Math.min(rect.left - 80, area.width - 280)) + 'px';
        _snapPickerEl.style.top  = (rect.bottom + 6) + 'px';
        _snapPickerEl.style.zIndex = '99999';

        document.body.appendChild(_snapPickerEl);

        // Animate in
        requestAnimationFrame(function() {
            if (_snapPickerEl) _snapPickerEl.classList.add('visible');
        });

        // Click handler for each layout option
        _snapPickerEl.querySelectorAll('.snap-picker-option').forEach(function(opt) {
            opt.addEventListener('click', function(e) {
                e.stopPropagation();
                var key = opt.getAttribute('data-key');
                applySnapLayoutToWindows(key, winId);
                hideSnapPicker();
            });
        });

        // Close on outside click
        setTimeout(function() {
            document.addEventListener('click', _onSnapPickerOutsideClick, { once: true });
        }, 50);

        // Close on mouse leave after delay
        _snapPickerEl.addEventListener('mouseleave', function() {
            _snapPickerTimeout = setTimeout(hideSnapPicker, 400);
        });
        _snapPickerEl.addEventListener('mouseenter', function() {
            clearTimeout(_snapPickerTimeout);
        });
    }

    function _onSnapPickerOutsideClick(e) {
        if (_snapPickerEl && !_snapPickerEl.contains(e.target)) {
            hideSnapPicker();
        }
    }

    function hideSnapPicker() {
        clearTimeout(_snapPickerTimeout);
        if (_snapPickerEl) {
            _snapPickerEl.remove();
            _snapPickerEl = null;
        }
        document.removeEventListener('click', _onSnapPickerOutsideClick);
    }

    function openLayoutOverlay() {
        if (_layoutOverlayEl) {
            closeLayoutOverlay();
            return;
        }

        var visibleWindows = [];
        windows.forEach(function(w) {
            if (!w.minimized) visibleWindows.push(w);
        });

        _layoutOverlayEl = document.createElement('div');
        _layoutOverlayEl.className = 'snap-layout-overlay';

        var html = '<div class="snap-layout-picker snap-layout-picker--overlay">' +
            '<div class="snap-layout-title">' + escapeHtml((typeof _ === 'function' ? _('desktop.label_snap_layout') : 'Window Layout')) + '</div>' +
            '<div class="snap-layout-help">' + escapeHtml('Arrange open application windows. Widgets stay in place.') + '</div>';

        if (visibleWindows.length > 0) {
            html += '<div class="snap-layout-options">';
            SNAP_LAYOUTS.forEach(function(layout) {
                html += '<button class="snap-layout-option" data-key="' + layout.key + '" title="' + escapeAttr(layout.label) + '">';
                html += '<div class="snap-layout-preview">';
                layout.zones.forEach(function(zone) {
                    html += '<div class="snap-zone-preview" style="left:' + (zone.x * 100) + '%;top:' + (zone.y * 100) + '%;width:' + (zone.w * 100) + '%;height:' + (zone.h * 100) + '%"></div>';
                });
                html += '</div>' +
                    '<div class="snap-layout-label">' + escapeHtml(layout.label) + '</div>' +
                    '</button>';
            });
            html += '</div>' +
                '<button class="snap-auto-arrange-btn" data-action="auto-arrange"><span class="material-icons">grid_view</span>' + escapeHtml('Tile Open Windows') + '</button>';
        } else {
            html += '<div class="snap-layout-empty">' + escapeHtml('Open at least one app window to use multi-window layouts.') + '</div>';
        }

        html += '</div>';
        _layoutOverlayEl.innerHTML = html;

        _layoutOverlayEl.addEventListener('click', function(e) {
            if (e.target === _layoutOverlayEl) closeLayoutOverlay();
        });

        if (visibleWindows.length > 0) {
            _layoutOverlayEl.querySelectorAll('.snap-layout-option').forEach(function(option) {
                option.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var primaryWinId = focusedWindowId || (visibleWindows[0] && visibleWindows[0].id) || null;
                    applySnapLayoutToWindows(option.getAttribute('data-key'), primaryWinId);
                    closeLayoutOverlay();
                });
            });

            var autoArrangeBtn = _layoutOverlayEl.querySelector('[data-action="auto-arrange"]');
            if (autoArrangeBtn) {
                autoArrangeBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    autoArrangeWindows();
                    closeLayoutOverlay();
                });
            }
        }

        document.body.appendChild(_layoutOverlayEl);
        requestAnimationFrame(function() {
            var picker = _layoutOverlayEl && _layoutOverlayEl.querySelector('.snap-layout-picker--overlay');
            if (picker) picker.classList.add('visible');
        });
    }

    function closeLayoutOverlay() {
        if (_layoutOverlayEl && _layoutOverlayEl.parentNode) {
            _layoutOverlayEl.parentNode.removeChild(_layoutOverlayEl);
        }
        _layoutOverlayEl = null;
    }

    function autoArrangeWindows() {
        var visibleWindows = [];
        windows.forEach(function(w) {
            if (!w.minimized) visibleWindows.push(w);
        });
        if (!visibleWindows.length) return;

        var area = getDesktopArea();
        var cols = Math.ceil(Math.sqrt(visibleWindows.length));
        var rows = Math.ceil(visibleWindows.length / cols);
        var pad = 3;
        var cellWidth = Math.floor(area.width / cols);
        var cellHeight = Math.floor(area.height / rows);

        clearActiveZoneLayout();

        visibleWindows.forEach(function(win, index) {
            var col = index % cols;
            var row = Math.floor(index / cols);

            win.x = Math.round(area.x + col * cellWidth + pad);
            win.y = Math.round(area.y + row * cellHeight + pad);
            win.width = Math.max(MIN_WIDTH, Math.round(cellWidth - pad * 2));
            win.height = Math.max(MIN_HEIGHT, Math.round(cellHeight - pad * 2));
            win.maximized = false;
            win.prevBounds = null;
            win.snappedZone = null;

            var el = document.getElementById(win.id);
            if (el) {
                el.classList.remove('maximized');
                el.style.transition = 'left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease';
                el.style.left = win.x + 'px';
                el.style.top = win.y + 'px';
                el.style.width = win.width + 'px';
                el.style.height = win.height + 'px';

                var maxIcon = el.querySelector('.maximize-btn .material-icons');
                if (maxIcon) maxIcon.textContent = 'crop_square';
                setTimeout(function() { el.style.transition = ''; }, 300);
            }

            saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
        });
    }

    function applySnapLayoutToWindows(layoutKey, primaryWinId) {
        var layout = SNAP_LAYOUTS.find(function(l) { return l.key === layoutKey; });
        if (!layout) return;

        var area = getDesktopArea();
        var PAD = 3;

        // Collect visible (non-minimized) windows, put primaryWinId first
        var winArr = [];
        windows.forEach(function(w) {
            if (!w.minimized) winArr.push(w);
        });

        // Sort: primary window first
        winArr.sort(function(a, b) {
            if (a.id === primaryWinId) return -1;
            if (b.id === primaryWinId) return 1;
            return 0;
        });

        winArr.forEach(function(w, idx) {
            if (idx >= layout.zones.length) return; // More windows than zones — skip extra
            var z = layout.zones[idx];

            w.x = Math.round(area.x + z.x * area.width + PAD);
            w.y = Math.round(area.y + z.y * area.height + PAD);
            w.width  = Math.round(z.w * area.width - PAD * 2);
            w.height = Math.round(z.h * area.height - PAD * 2);
            w.width  = Math.max(MIN_WIDTH, w.width);
            w.height = Math.max(MIN_HEIGHT, w.height);
            w.maximized = false;
            w.snappedZone = layoutKey + '-' + idx;

            var el = document.getElementById(w.id);
            if (el) {
                el.classList.remove('maximized');
                el.style.transition = 'left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease';
                el.style.left   = w.x + 'px';
                el.style.top    = w.y + 'px';
                el.style.width  = w.width + 'px';
                el.style.height = w.height + 'px';
                var maxIcon = el.querySelector('.maximize-btn .material-icons');
                if (maxIcon) maxIcon.textContent = 'crop_square';
                setTimeout(function() { el.style.transition = ''; }, 300);
            }

            saveWindowBounds(w.appId, w.x, w.y, w.width, w.height);
        });

        // Track active layout for draggable zone borders
        _activeLayoutKey = layoutKey;
        _activeZones = layout.zones.map(function(z) { return { x: z.x, y: z.y, w: z.w, h: z.h }; });
        _zoneWinMap = winArr.slice(0, layout.zones.length).map(function(w) { return w.id; });
        createZoneDividers();
    }

    // ============ Draggable Zone Borders ============

    /**
     * Detect shared edges between adjacent zones and create draggable divider elements.
     * Dividers are thin hit-areas placed at shared boundaries that the user can drag
     * to resize adjacent zones proportionally.
     */
    function createZoneDividers() {
        removeZoneDividers();
        if (!_activeZones || _activeZones.length < 2) return;

        var area = getDesktopArea();
        var container = document.getElementById('desktop-windows') || document.body;
        var edges = findSharedEdges(_activeZones);

        edges.forEach(function(edge, idx) {
            var div = document.createElement('div');
            div.className = 'zone-divider zone-divider-' + edge.axis;
            div.dataset.dividerIdx = idx;

            // Position the divider along the shared edge
            var PAD = 3;
            if (edge.axis === 'col') {
                // Vertical divider between left/right zones
                var cx = area.x + edge.pos * area.width;
                var minY = Math.min.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].y; }));
                var maxY = Math.max.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].y + _activeZones[zi].h; }));
                div.style.left   = (cx - ZONE_DIVIDER_HIT / 2) + 'px';
                div.style.top    = (area.y + minY * area.height + PAD) + 'px';
                div.style.width  = ZONE_DIVIDER_HIT + 'px';
                div.style.height = ((maxY - minY) * area.height - PAD * 2) + 'px';
                div.style.cursor = 'col-resize';
            } else {
                // Horizontal divider between top/bottom zones
                var cy = area.y + edge.pos * area.height;
                var minX = Math.min.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].x; }));
                var maxX = Math.max.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].x + _activeZones[zi].w; }));
                div.style.left   = (area.x + minX * area.width + PAD) + 'px';
                div.style.top    = (cy - ZONE_DIVIDER_HIT / 2) + 'px';
                div.style.width  = ((maxX - minX) * area.width - PAD * 2) + 'px';
                div.style.height = ZONE_DIVIDER_HIT + 'px';
                div.style.cursor = 'row-resize';
            }

            div.addEventListener('mousedown', onZoneDividerMouseDown);
            container.appendChild(div);
            _zoneDividers.push({ el: div, edge: edge });
        });
    }

    function removeZoneDividers() {
        _zoneDividers.forEach(function(d) { d.el.remove(); });
        _zoneDividers = [];
    }

    /**
     * Find shared edges between zones. A shared edge is where one zone's right
     * boundary equals another zone's left boundary (col), or one zone's bottom
     * equals another's top (row).
     * Returns array of { axis: 'col'|'row', pos: fraction, zones: [zoneIdx...], leftZones: [...], rightZones: [...] }
     */
    function findSharedEdges(zones) {
        var EPSILON = 0.01;
        var edges = [];
        var seen = {};

        for (var i = 0; i < zones.length; i++) {
            for (var j = i + 1; j < zones.length; j++) {
                var a = zones[i], b = zones[j];

                // Check vertical shared edge: a.right == b.left or b.right == a.left
                var aRight = a.x + a.w;
                var bRight = b.x + b.w;

                if (Math.abs(aRight - b.x) < EPSILON) {
                    // a is to the left of b, shared vertical edge at aRight
                    addEdge(edges, seen, 'col', aRight, i, j, 'left', 'right');
                } else if (Math.abs(bRight - a.x) < EPSILON) {
                    // b is to the left of a
                    addEdge(edges, seen, 'col', bRight, j, i, 'left', 'right');
                }

                // Check horizontal shared edge: a.bottom == b.top or b.bottom == a.top
                var aBottom = a.y + a.h;
                var bBottom = b.y + b.h;

                if (Math.abs(aBottom - b.y) < EPSILON) {
                    // a is above b
                    addEdge(edges, seen, 'row', aBottom, i, j, 'top', 'bottom');
                } else if (Math.abs(bBottom - a.y) < EPSILON) {
                    // b is above a
                    addEdge(edges, seen, 'row', bBottom, j, i, 'top', 'bottom');
                }
            }
        }
        return edges;
    }

    function addEdge(edges, seen, axis, pos, leftIdx, rightIdx, leftSide, rightSide) {
        var key = axis + ':' + pos.toFixed(4);
        if (!seen[key]) {
            seen[key] = { axis: axis, pos: pos, zones: [], leftZones: [], rightZones: [] };
            edges.push(seen[key]);
        }
        var e = seen[key];
        if (e.zones.indexOf(leftIdx) === -1) e.zones.push(leftIdx);
        if (e.zones.indexOf(rightIdx) === -1) e.zones.push(rightIdx);
        if (e.leftZones.indexOf(leftIdx) === -1) e.leftZones.push(leftIdx);
        if (e.rightZones.indexOf(rightIdx) === -1) e.rightZones.push(rightIdx);
    }

    function onZoneDividerMouseDown(e) {
        e.preventDefault();
        e.stopPropagation();

        var idx = parseInt(e.target.dataset.dividerIdx, 10);
        if (isNaN(idx) || !_zoneDividers[idx]) return;

        var edge = _zoneDividers[idx].edge;
        _zoneDragState = {
            dividerIdx: idx,
            axis: edge.axis,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            origZones: _activeZones.map(function(z) { return { x: z.x, y: z.y, w: z.w, h: z.h }; }),
            edge: edge
        };

        document.addEventListener('mousemove', onZoneDividerMouseMove);
        document.addEventListener('mouseup', onZoneDividerMouseUp);
        document.body.style.cursor = edge.axis === 'col' ? 'col-resize' : 'row-resize';
        document.body.classList.add('zone-resizing');
    }

    function onZoneDividerMouseMove(e) {
        if (!_zoneDragState || !_activeZones) return;

        var area = getDesktopArea();
        var ds = _zoneDragState;
        var delta;

        if (ds.axis === 'col') {
            delta = (e.clientX - ds.startMouseX) / area.width;
        } else {
            delta = (e.clientY - ds.startMouseY) / area.height;
        }

        // Apply delta to zones: shrink left/top zones, grow right/bottom zones (or vice versa)
        var origZones = ds.origZones;
        var canApply = true;

        // Check that all affected zones stay above minimum size
        ds.edge.leftZones.forEach(function(zi) {
            var orig = origZones[zi];
            var newSize = ds.axis === 'col' ? orig.w + delta : orig.h + delta;
            if (newSize < ZONE_MIN_FRACTION) canApply = false;
        });
        ds.edge.rightZones.forEach(function(zi) {
            var orig = origZones[zi];
            var newSize = ds.axis === 'col' ? orig.w - delta : orig.h - delta;
            if (newSize < ZONE_MIN_FRACTION) canApply = false;
        });

        if (!canApply) return;

        // Apply the resize
        ds.edge.leftZones.forEach(function(zi) {
            var orig = origZones[zi];
            if (ds.axis === 'col') {
                _activeZones[zi].w = orig.w + delta;
            } else {
                _activeZones[zi].h = orig.h + delta;
            }
        });
        ds.edge.rightZones.forEach(function(zi) {
            var orig = origZones[zi];
            if (ds.axis === 'col') {
                _activeZones[zi].x = orig.x + delta;
                _activeZones[zi].w = orig.w - delta;
            } else {
                _activeZones[zi].y = orig.y + delta;
                _activeZones[zi].h = orig.h - delta;
            }
        });

        // Update window positions to match new zone sizes
        updateWindowsFromZones(area);
        // Update divider positions
        updateZoneDividerPositions(area);
    }

    function onZoneDividerMouseUp() {
        document.removeEventListener('mousemove', onZoneDividerMouseMove);
        document.removeEventListener('mouseup', onZoneDividerMouseUp);
        document.body.style.cursor = '';
        document.body.classList.remove('zone-resizing');
        _zoneDragState = null;

        // Save window bounds after resize
        if (_activeZones && _zoneWinMap) {
            _zoneWinMap.forEach(function(winId) {
                var win = windows.get(winId);
                if (win) saveWindowBounds(win.appId, win.x, win.y, win.width, win.height);
            });
        }
    }

    function updateWindowsFromZones(area) {
        if (!_activeZones || !_zoneWinMap) return;
        var PAD = 6;

        _zoneWinMap.forEach(function(winId, idx) {
            if (idx >= _activeZones.length) return;
            var z = _activeZones[idx];
            var win = windows.get(winId);
            if (!win) return;

            win.x = Math.round(area.x + z.x * area.width + PAD);
            win.y = Math.round(area.y + z.y * area.height + PAD);
            win.width  = Math.max(MIN_WIDTH, Math.round(z.w * area.width - PAD * 2));
            win.height = Math.max(MIN_HEIGHT, Math.round(z.h * area.height - PAD * 2));

            var el = document.getElementById(winId);
            if (el) {
                el.style.left   = win.x + 'px';
                el.style.top    = win.y + 'px';
                el.style.width  = win.width + 'px';
                el.style.height = win.height + 'px';
            }
        });
    }

    function updateZoneDividerPositions(area) {
        var PAD = 6;
        _zoneDividers.forEach(function(d) {
            var edge = d.edge;
            var el = d.el;

            if (edge.axis === 'col') {
                var cx = area.x + edge.pos * area.width;
                // Recalculate pos from active zones (leftZones right edge)
                if (edge.leftZones.length > 0) {
                    var zi = edge.leftZones[0];
                    cx = area.x + (_activeZones[zi].x + _activeZones[zi].w) * area.width;
                    // Update edge.pos for consistency
                    edge.pos = _activeZones[zi].x + _activeZones[zi].w;
                }
                var minY = Math.min.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].y; }));
                var maxY = Math.max.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].y + _activeZones[zi].h; }));
                el.style.left   = (cx - ZONE_DIVIDER_HIT / 2) + 'px';
                el.style.top    = (area.y + minY * area.height + PAD) + 'px';
                el.style.height = ((maxY - minY) * area.height - PAD * 2) + 'px';
            } else {
                var cy = area.y + edge.pos * area.height;
                if (edge.leftZones.length > 0) {
                    var zi2 = edge.leftZones[0];
                    cy = area.y + (_activeZones[zi2].y + _activeZones[zi2].h) * area.height;
                    edge.pos = _activeZones[zi2].y + _activeZones[zi2].h;
                }
                var minX = Math.min.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].x; }));
                var maxX = Math.max.apply(null, edge.zones.map(function(zi) { return _activeZones[zi].x + _activeZones[zi].w; }));
                el.style.left   = (area.x + minX * area.width + PAD) + 'px';
                el.style.top    = (cy - ZONE_DIVIDER_HIT / 2) + 'px';
                el.style.width  = ((maxX - minX) * area.width - PAD * 2) + 'px';
            }
        });
    }

    /** Remove zone border tracking when user manually moves a window */
    function clearActiveZoneLayout() {
        _activeLayoutKey = null;
        _activeZones = null;
        _zoneWinMap = [];
        removeZoneDividers();
    }

    // ============ Aero Shake ============

    var SHAKE_THRESHOLD = 40;  // px total movement to detect shake
    var SHAKE_WINDOW_MS = 500; // time window for shake detection

    function detectAeroShake(winId, clientX, clientY) {
        var now = Date.now();
        _shakeOrigins.push({ x: clientX, y: clientY, t: now });

        // Keep only recent samples
        _shakeOrigins = _shakeOrigins.filter(function(s) { return now - s.t < SHAKE_WINDOW_MS; });

        if (_shakeOrigins.length < 4) return false;

        // Calculate total direction changes (X-axis)
        var dirChanges = 0;
        for (var i = 2; i < _shakeOrigins.length; i++) {
            var d1 = _shakeOrigins[i-1].x - _shakeOrigins[i-2].x;
            var d2 = _shakeOrigins[i].x - _shakeOrigins[i-1].x;
            if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) dirChanges++;
        }

        // Total X displacement
        var totalDx = 0;
        for (var j = 1; j < _shakeOrigins.length; j++) {
            totalDx += Math.abs(_shakeOrigins[j].x - _shakeOrigins[j-1].x);
        }

        if (dirChanges >= 3 && totalDx > SHAKE_THRESHOLD) {
            _shakeOrigins = [];
            return true;
        }
        return false;
    }

    function aeroShake(keepWinId) {
        var allMinimized = true;
        windows.forEach(function(w) {
            if (w.id !== keepWinId && !w.minimized) allMinimized = false;
        });

        if (allMinimized) {
            // Un-shake: restore all
            windows.forEach(function(w) {
                if (w.id !== keepWinId && w.minimized && w._shakedMinimized) {
                    restoreWindow(w.id);
                    w._shakedMinimized = false;
                }
            });
        } else {
            // Shake: minimize all except this one
            windows.forEach(function(w) {
                if (w.id !== keepWinId && !w.minimized) {
                    w._shakedMinimized = true;
                    minimizeWindow(w.id);
                }
            });
        }
    }

    // ============ Taskbar (slim full-width bar with tab indicators) ============

    function updateTaskbar() {
        var container = document.getElementById('taskbar-apps');
        if (!container) return;
        container.innerHTML = '';

        windows.forEach(function(win) {
            var tab = document.createElement('button');
            tab.className = 'taskbar-tab';
            if (!win.minimized) tab.classList.add('active');
            if (win.id === focusedWindowId) tab.classList.add('focused');

            tab.style.setProperty('--tab-color', sanitizeAppColor(win.app.color));

            var indicator = document.createElement('span');
            indicator.className = 'taskbar-tab-indicator';

            var tabContent = document.createElement('span');
            tabContent.className = 'taskbar-tab-content';
            tabContent.appendChild(createMaterialIconSpan(win.app.icon, {
                className: 'material-icons taskbar-tab-icon',
                color: win.app.color
            }));

            var tabLabel = document.createElement('span');
            tabLabel.className = 'taskbar-tab-label';
            tabLabel.textContent = win.app.name || '';

            tabContent.appendChild(tabLabel);
            tab.appendChild(indicator);
            tab.appendChild(tabContent);

            tab.title = win.app.name;

            tab.addEventListener('click', function() {
                if (win.minimized) {
                    restoreWindow(win.id);
                } else if (win.id === focusedWindowId) {
                    minimizeWindow(win.id);
                } else {
                    focusWindow(win.id);
                }
            });

            container.appendChild(tab);
        });

        updateTaskbarVisibility();
    }

    function clearTaskbar() {
        var container = document.getElementById('taskbar-apps');
        if (container) container.innerHTML = '';
    }

    // ============ Helpers ============

    function shouldReserveTaskbarSpace() {
        // Slim taskbar is always 10px, reserve minimal space
        if (!active) return false;
        var taskbar = document.getElementById('desktop-taskbar');
        return !!taskbar;
    }

    function getDesktopArea() {
        var vp = window.visualViewport;
        var vpWidth = vp ? vp.width : window.innerWidth;
        var vpHeight = vp ? vp.height : window.innerHeight;

        // Slim taskbar reserves TASKBAR_HEIGHT pixels at bottom
        var bottomOffset = shouldReserveTaskbarSpace() ? TASKBAR_HEIGHT : 0;

        var safeBottom = 0;
        try {
            var cs = getComputedStyle(document.documentElement);
            safeBottom = parseInt(cs.getPropertyValue('--desktop-safe-bottom'), 10) || 0;
        } catch (e) { /* ignore */ }

        return {
            x: 0,
            y: 0,
            width: vpWidth,
            height: vpHeight - 36 - bottomOffset - safeBottom
        };
    }

    function sanitizeAppColor(color) {
        if (typeof Utils !== 'undefined' && Utils.sanitizeColor) {
            return Utils.sanitizeColor(color);
        }
        var s = String(color || '');
        if (/^#[0-9A-Fa-f]{3}$/.test(s) || /^#[0-9A-Fa-f]{6}$/.test(s)) return s;
        return '#808080';
    }

    function sanitizeMaterialIcon(name) {
        var s = String(name || 'apps').trim();
        if (/^[a-z0-9_]+$/.test(s)) return s;
        return 'apps';
    }

    function createMaterialIconSpan(iconName, options) {
        options = options || {};
        var span = document.createElement('span');
        span.className = options.className || 'material-icons';
        if (options.color) {
            span.style.color = sanitizeAppColor(options.color);
        }
        if (options.fontSize) {
            span.style.fontSize = options.fontSize;
        }
        span.textContent = sanitizeMaterialIcon(iconName);
        return span;
    }

    function createWindowCtrlBtn(action, iconName, title) {
        var btn = document.createElement('button');
        btn.className = 'window-ctrl-btn ' + action + '-btn';
        btn.setAttribute('data-action', action);
        btn.title = title || '';
        btn.appendChild(createMaterialIconSpan(iconName));
        return btn;
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                          .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ============ Top Bar (clock + shortcuts + controls) ============

    var _topbarClockInterval = null;
    var _topbarEditMode = false;
    var STORAGE_SHORTCUTS = 'betterdesk_topbar_shortcuts';

    function getTopbarShortcuts() {
        try { return JSON.parse(localStorage.getItem(STORAGE_SHORTCUTS) || '[]'); }
        catch (_) { return []; }
    }

    function saveTopbarShortcuts(list) {
        try { localStorage.setItem(STORAGE_SHORTCUTS, JSON.stringify(list)); }
        catch (_) { /* quota */ }
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            var shell = document.getElementById('desktop-shell') || document.documentElement;
            if (shell.requestFullscreen) shell.requestFullscreen();
            else if (shell.webkitRequestFullscreen) shell.webkitRequestFullscreen();
            else if (shell.msRequestFullscreen) shell.msRequestFullscreen();
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            else if (document.msExitFullscreen) document.msExitFullscreen();
        }
    }

    function initTopbar() {
        var clockEl = document.getElementById('topbar-clock');
        if (clockEl) {
            function updateClock() {
                var now = new Date();
                clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            updateClock();
            _topbarClockInterval = setInterval(updateClock, 30000);
        }

        var exitBtn = document.getElementById('topbar-exit-btn');
        if (exitBtn) exitBtn.addEventListener('click', function() { deactivate(); });



        var widgetsBtn = document.getElementById('topbar-widgets-btn');
        if (widgetsBtn) widgetsBtn.addEventListener('click', function() {
            if (window.DesktopWidgets && typeof window.DesktopWidgets.openPicker === 'function') {
                window.DesktopWidgets.openPicker();
            }
        });

        var addWidgetBtn = document.getElementById('topbar-add-widget-btn');
        if (addWidgetBtn) addWidgetBtn.addEventListener('click', function() {
            if (window.DesktopWidgets && typeof window.DesktopWidgets.openPicker === 'function') {
                window.DesktopWidgets.openPicker();
            }
        });

        var wallpaperBtn = document.getElementById('topbar-wallpaper-btn');
        if (wallpaperBtn) wallpaperBtn.addEventListener('click', function() {
            if (window.DesktopWidgets && typeof window.DesktopWidgets.openWallpaperPicker === 'function') {
                window.DesktopWidgets.openWallpaperPicker();
            }
        });

        var fullscreenBtn = document.getElementById('topbar-fullscreen-btn');
        if (fullscreenBtn) fullscreenBtn.addEventListener('click', function() {
            toggleFullscreen();
        });

        // Sync fullscreen icon when state changes (Esc key, etc.)
        document.addEventListener('fullscreenchange', function() {
            var btn = document.getElementById('topbar-fullscreen-btn');
            if (!btn) return;
            var icon = btn.querySelector('.material-icons');
            if (icon) icon.textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
        });

        var snapLayoutBtn = document.getElementById('topbar-snap-layout-btn');
        if (snapLayoutBtn) snapLayoutBtn.addEventListener('click', function() {
            if (window.DesktopWidgets && typeof window.DesktopWidgets.openSnapLayout === 'function') {
                window.DesktopWidgets.openSnapLayout();
            } else {
                openSnapLayoutPicker();
            }
        });

        var editBtn = document.getElementById('topbar-edit-btn');
        if (editBtn) editBtn.addEventListener('click', function() {
            toggleTopbarEditMode();
        });

        var helpBtn = document.getElementById('topbar-help-btn');
        if (helpBtn) helpBtn.addEventListener('click', function() {
            if (window.BetterDeskTutorial && typeof window.BetterDeskTutorial.toggleHelpMenu === 'function') {
                window.BetterDeskTutorial.toggleHelpMenu();
            } else if (window.Tutorial && typeof window.Tutorial.toggleHelpMenu === 'function') {
                window.Tutorial.toggleHelpMenu();
            }
        });

        renderTopbarShortcuts();
        initTopbarDropZone();
    }

    function destroyTopbar() {
        if (_topbarClockInterval) { clearInterval(_topbarClockInterval); _topbarClockInterval = null; }
        _topbarEditMode = false;
    }

    function renderTopbarShortcuts() {
        var container = document.getElementById('topbar-shortcuts');
        if (!container) return;
        container.innerHTML = '';

        var shortcuts = getTopbarShortcuts();
        shortcuts.forEach(function(sc, idx) {
            var btn = document.createElement('button');
            btn.className = 'topbar-shortcut-btn';
            btn.title = sc.name || sc.id;
            btn.setAttribute('data-shortcut-idx', idx);
            var scColor = sanitizeAppColor(sc.color || '#8b949e');
            btn.style.setProperty('--sc-color', scColor);
            btn.appendChild(createMaterialIconSpan(sc.icon || 'open_in_new', { color: scColor }));

            btn.addEventListener('click', function(e) {
                if (_topbarEditMode) return; // In edit mode, don't open
                var apps = getApps();
                var app = apps.find(function(a) { return a.id === sc.id; });
                if (!app) {
                    app = { id: sc.id, icon: sc.icon, route: sc.route, color: sc.color, name: sc.name, category: sc.category || 'main' };
                }
                openApp(app);
            });

            if (_topbarEditMode) {
                btn.setAttribute('draggable', 'true');
                btn.classList.add('edit-mode');

                // Remove button
                var removeBtn = document.createElement('span');
                removeBtn.className = 'topbar-shortcut-remove';
                removeBtn.innerHTML = '&times;';
                removeBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var list = getTopbarShortcuts();
                    list.splice(idx, 1);
                    saveTopbarShortcuts(list);
                    renderTopbarShortcuts();
                });
                btn.appendChild(removeBtn);

                btn.addEventListener('dragstart', function(e) {
                    e.dataTransfer.setData('text/shortcut-idx', String(idx));
                    e.dataTransfer.effectAllowed = 'move';
                    btn.classList.add('dragging');
                });
                btn.addEventListener('dragend', function() {
                    btn.classList.remove('dragging');
                });
                btn.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    btn.classList.add('drag-over');
                });
                btn.addEventListener('dragleave', function() {
                    btn.classList.remove('drag-over');
                });
                btn.addEventListener('drop', function(e) {
                    e.preventDefault();
                    btn.classList.remove('drag-over');
                    var fromIdx = parseInt(e.dataTransfer.getData('text/shortcut-idx'), 10);
                    if (isNaN(fromIdx)) return;
                    var list = getTopbarShortcuts();
                    if (fromIdx >= 0 && fromIdx < list.length) {
                        var moved = list.splice(fromIdx, 1)[0];
                        list.splice(idx, 0, moved);
                        saveTopbarShortcuts(list);
                        renderTopbarShortcuts();
                    }
                });
            }

            container.appendChild(btn);
        });
    }

    function initTopbarDropZone() {
        var container = document.getElementById('topbar-shortcuts');
        if (!container) return;

        container.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            container.classList.add('drag-over');
        });
        container.addEventListener('dragleave', function(e) {
            if (!container.contains(e.relatedTarget)) {
                container.classList.remove('drag-over');
            }
        });
        container.addEventListener('drop', function(e) {
            e.preventDefault();
            container.classList.remove('drag-over');

            // Reorder within shortcuts
            var reorderIdx = e.dataTransfer.getData('text/shortcut-idx');
            if (reorderIdx) return; // Handled by individual btn drop

            // Drop from app drawer
            var raw = e.dataTransfer.getData('text/plain');
            if (!raw) return;
            try {
                var appData = JSON.parse(raw);
                if (!appData || !appData.id) return;

                var list = getTopbarShortcuts();
                // Don't add duplicates
                if (list.some(function(s) { return s.id === appData.id; })) return;

                list.push({ id: appData.id, icon: appData.icon, route: appData.route, color: appData.color, name: appData.name, category: appData.category });
                saveTopbarShortcuts(list);
                renderTopbarShortcuts();
            } catch (_) { /* Not valid JSON */ }
        });
    }

    function toggleTopbarEditMode() {
        _topbarEditMode = !_topbarEditMode;
        var btn = document.getElementById('topbar-edit-btn');
        if (btn) {
            btn.classList.toggle('active', _topbarEditMode);
            var icon = btn.querySelector('.material-icons');
            if (icon) icon.textContent = _topbarEditMode ? 'done' : 'edit';
        }
        var container = document.getElementById('topbar-shortcuts');
        if (container) container.classList.toggle('edit-mode', _topbarEditMode);
        renderTopbarShortcuts();
    }

    // ============ App Drawer ============

    var _appDrawerOpen = false;

    function initAppDrawer() {
        var btn = document.getElementById('topbar-app-drawer-btn');
        var overlay = document.getElementById('app-drawer-overlay');
        var grid = document.getElementById('app-drawer-grid');
        var search = document.getElementById('app-drawer-search');
        if (!overlay || !grid) return;

        renderAppDrawerGrid(grid, '');

        function onDrawerBtnClick(e) {
            e.stopPropagation();
            toggleAppDrawer();
        }

        if (btn) btn.addEventListener('click', onDrawerBtnClick);

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) closeAppDrawer();
        });

        if (search) {
            search.addEventListener('input', function() {
                renderAppDrawerGrid(grid, search.value.toLowerCase());
            });
        }

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && _appDrawerOpen) closeAppDrawer();
        });
    }

    function renderAppDrawerGrid(grid, filter) {
        grid.innerHTML = '';
        var apps = getApps();
        var t = typeof _ === 'function' ? _ : function(k) { return k; };
        var categories = ['main', 'management', 'tools', 'system', 'settings'];
        var catNames = {
            main: t('nav.main'),
            management: t('nav.management') || 'Management',
            tools: t('nav.tools'),
            system: t('nav.system'),
            settings: t('nav.settings')
        };

        categories.forEach(function(cat) {
            var catApps = apps.filter(function(a) {
                return a.category === cat &&
                       (!filter || a.name.toLowerCase().indexOf(filter) !== -1 || a.id.indexOf(filter) !== -1);
            });
            if (catApps.length === 0) return;

            var header = document.createElement('div');
            header.className = 'app-drawer-category';
            header.textContent = catNames[cat] || cat;
            grid.appendChild(header);

            var row = document.createElement('div');
            row.className = 'app-drawer-row';
            catApps.forEach(function(app) {
                var tile = document.createElement('button');
                tile.className = 'app-drawer-tile';
                tile.setAttribute('draggable', 'true');
                tile.setAttribute('data-app-id', app.id);
                tile.appendChild(createMaterialIconSpan(app.icon, {
                    color: app.color,
                    fontSize: '28px'
                }));
                var tileName = document.createElement('span');
                tileName.className = 'app-drawer-tile-name';
                tileName.textContent = app.name || '';
                tile.appendChild(tileName);
                tile.addEventListener('click', function() {
                    closeAppDrawer();
                    openApp(app);
                });
                // Drag support for adding to top bar shortcuts
                tile.addEventListener('dragstart', function(e) {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ id: app.id, icon: app.icon, route: app.route, color: app.color, name: app.name, category: app.category }));
                    e.dataTransfer.effectAllowed = 'copy';
                    tile.classList.add('dragging');
                });
                tile.addEventListener('dragend', function() {
                    tile.classList.remove('dragging');
                });
                row.appendChild(tile);
            });
            grid.appendChild(row);
        });
    }

    function toggleAppDrawer() {
        _appDrawerOpen ? closeAppDrawer() : openAppDrawer();
    }

    function openAppDrawer() {
        var overlay = document.getElementById('app-drawer-overlay');
        var search = document.getElementById('app-drawer-search');
        if (!overlay) return;
        overlay.style.display = 'flex';
        _appDrawerOpen = true;
        if (search) { search.value = ''; search.focus(); }
        renderAppDrawerGrid(document.getElementById('app-drawer-grid'), '');
    }

    function closeAppDrawer() {
        var overlay = document.getElementById('app-drawer-overlay');
        if (overlay) overlay.style.display = 'none';
        _appDrawerOpen = false;
    }

    // ============ Mode Switching (Windows ↔ Widgets) ============

    function switchMode(mode) {
        if (mode === currentMode) return;
        currentMode = mode;
        localStorage.setItem(STORAGE_MODE, mode);
        applyMode(mode);
    }

    function applyMode(mode) {
        // Unified mode: widgets always visible, windows layer on top
        document.body.classList.remove('desktop-mode-widgets', 'desktop-mode-windows');
        document.body.classList.add('desktop-mode-unified');

        // Always show windows container (for float windows)
        var winsContainer = document.getElementById('desktop-windows');
        if (winsContainer) winsContainer.style.display = '';

        // Hide desktop icons in unified mode (apps open as windows)
        var iconsContainer = document.getElementById('desktop-icons');
        if (iconsContainer) iconsContainer.style.display = 'none';

        // Always initialize widgets
        if (window.DesktopWidgets) {
            window.DesktopWidgets.init();
            window.DesktopWidgets.renderAddButton();
        }
    }

    // ============ Open App By Route ============

    // Extra route → app mappings for pages not in getApps()
    function _getExtraRoutes() {
        return {
            '/audit':        { id: 'audit',      icon: 'monitoring',          color: '#f0883e', name: t('nav.activity') },
            '/network':      { id: 'network',    icon: 'wifi',                color: '#56d364', name: t('nav.network') },
            '/cdap/devices': { id: 'cdap',       icon: 'developer_board',     color: '#79c0ff', name: t('nav.cdap') },
            '/tokens':       { id: 'tokens',     icon: 'token',               color: '#d2a8ff', name: t('nav.tokens') },
            '/inventory':    { id: 'inventory',   icon: 'inventory_2',         color: '#f78166', name: t('nav.inventory') },
            '/tickets':      { id: 'tickets',     icon: 'confirmation_number', color: '#d2a8ff', name: t('nav.tickets') },
            '/automation':   { id: 'automation',  icon: 'auto_fix_high',       color: '#56d364', name: t('nav.automation') },
            '/reports':      { id: 'reports',     icon: 'assessment',          color: '#79c0ff', name: t('nav.reports') },
            '/dataguard':    { id: 'dataguard',   icon: 'shield',              color: '#f0883e', name: t('nav.dataguard') },
            '/tenants':      { id: 'tenants',     icon: 'business',            color: '#d2a8ff', name: t('nav.tenants') },
            '/activity':     { id: 'activity',    icon: 'timeline',            color: '#f0883e', name: t('nav.activity') }
        };
    }

    function openAppByRoute(route) {
        if (!active) return;
        if (!route) return;

        // Unified mode: open apps directly as float windows (no mode switching)

        // Find matching app in getApps()
        var apps = getApps();
        var found = null;
        for (var i = 0; i < apps.length; i++) {
            if (apps[i].route === route) { found = apps[i]; break; }
        }

        // Check extra routes
        var extraRoutes = _getExtraRoutes();
        if (!found && extraRoutes[route]) {
            found = Object.assign({ route: route }, extraRoutes[route]);
        }

        // Fallback: create ad-hoc app entry
        if (!found) {
            var label = route.replace(/^\//, '').replace(/\//g, ' > ') || 'Page';
            found = { id: 'page-' + route.replace(/\W/g, '_'), icon: 'open_in_new', route: route, color: '#8b949e', name: label };
        }

        openApp(found);
    }



    // ============ Public API ============

    window.DesktopMode = {
        init: init,
        toggle: toggle,
        isActive: function() { return active; },
        activate: activate,
        deactivate: deactivate,
        switchMode: switchMode,
        getMode: function() { return currentMode; },
        openAppByRoute: openAppByRoute,

        // Snap Layout API
        showSnapPicker: showSnapPicker,
        hideSnapPicker: hideSnapPicker,
        openLayoutOverlay: openLayoutOverlay,
        closeLayoutOverlay: closeLayoutOverlay,
        applySnapLayout: applySnapLayoutToWindows,
        autoArrangeWindows: autoArrangeWindows,
        getSnapLayouts: function() { return SNAP_LAYOUTS; },
        clearZoneLayout: clearActiveZoneLayout,
        // Foldable device API
        isFoldable: function() { return isFoldableDevice; },
        getDevicePosture: function() { return devicePosture; },
        setFoldableAutoSwitch: setFoldableAutoSwitch,
        isFoldableAutoSwitchEnabled: isFoldableAutoSwitchEnabled
    };

})();
