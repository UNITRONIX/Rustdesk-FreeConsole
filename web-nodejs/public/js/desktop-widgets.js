/**
 * BetterDesk Console — Desktop Widget Engine
 * Manages draggable/resizable glassmorphic widgets on a wallpaper canvas.
 * Depends: desktop-mode.js (DesktopMode), Utils, _ (i18n)
 */

(function () {
    'use strict';

    // ============ Constants ============

    var GRID = 20;
    var MIN_W = 160;
    var MIN_H = 120;
    var EDGE_SNAP_THRESHOLD = 15;  // px — magnetic edge snapping distance
    var STORAGE_LAYOUT  = 'bd_widget_layout';
    var STORAGE_WALL    = 'bd_widget_wallpaper';
    var LAYOUT_VERSION  = 3;
    var STORAGE_LAYOUT_VER = 'bd_widget_layout_ver';
    var WALLPAPER_COUNT = 125;
    var UPDATE_INTERVAL = 30000;      // 30 s default widget data refresh
    var SAVE_DEBOUNCE   = 600;
    var _showGrid = false;
    var _gridOverlay = null;

    // ============ State ============

    var _widgets    = new Map();      // id → { id, type, x, y, w, h, z, config }
    var _zCounter   = 1;
    var _focusedId  = null;
    var _canvas     = null;
    var _dragState   = null;
    var _resizeState = null;
    var _pickerOpen  = false;
    var _wallpicker  = false;
    var _updateTimers = new Map();
    var _wallpaperPath = null;
    var _popouts     = new Map();     // widgetId → { win: Window, timer: intervalId }

    // ============ Helpers ============

    var t = function (k) { return typeof _ === 'function' ? _(k) : k; };

    function snap(val) { return Math.round(val / GRID) * GRID; }

    /** Snap value to edge if within threshold */
    function edgeSnap(val, edges) {
        for (var i = 0; i < edges.length; i++) {
            if (Math.abs(val - edges[i]) <= EDGE_SNAP_THRESHOLD) return edges[i];
        }
        return snap(val);
    }

    /** Get snap edges from other widgets */
    function getSnapEdges(excludeId) {
        var edges = { x: [0], y: [0] };
        var area = getCanvasArea();
        edges.x.push(area.w);
        edges.y.push(area.h);
        _widgets.forEach(function (w) {
            if (w.id === excludeId) return;
            edges.x.push(w.x, w.x + w.w);
            edges.y.push(w.y, w.y + w.h);
        });
        return edges;
    }

    /** Toggle visual grid overlay */
    function toggleGridOverlay() {
        _showGrid = !_showGrid;
        if (_showGrid) {
            showGridOverlay();
        } else {
            hideGridOverlay();
        }
    }

    function showGridOverlay() {
        if (_gridOverlay) return;
        if (!_canvas) return;
        _gridOverlay = document.createElement('div');
        _gridOverlay.className = 'widget-grid-overlay';
        _gridOverlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0;' +
            'background-image:radial-gradient(circle,rgba(88,166,255,0.15) 1px,transparent 1px);' +
            'background-size:' + GRID + 'px ' + GRID + 'px;opacity:0;transition:opacity .3s';
        _canvas.appendChild(_gridOverlay);
        requestAnimationFrame(function () { if (_gridOverlay) _gridOverlay.style.opacity = '1'; });
    }

    function hideGridOverlay() {
        if (!_gridOverlay) return;
        _gridOverlay.style.opacity = '0';
        var el = _gridOverlay;
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
        _gridOverlay = null;
    }

    function uid() {
        return 'w-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    /** Close all open kebab menus except optionally the one inside excludeEl */
    function _closeAllKebabMenus(excludeEl) {
        document.querySelectorAll('.widget-kebab-menu.open').forEach(function (m) {
            if (excludeEl && excludeEl.contains(m)) return;
            m.classList.remove('open');
        });
    }

    // Global click closes any open kebab menu
    document.addEventListener('click', function () { _closeAllKebabMenus(); });

    // ============ Initialization ============

    function init() {
        _canvas = document.getElementById('widget-canvas');
        if (!_canvas) {
            _canvas = document.createElement('div');
            _canvas.id = 'widget-canvas';
            _canvas.className = 'widget-canvas';
            var shell = document.getElementById('desktop-shell');
            if (shell) shell.insertBefore(_canvas, shell.firstChild.nextSibling); // after wallpaper
        }

        _canvas.addEventListener('mousedown', function (e) {
            if (e.target === _canvas) unfocus();
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        // Touch support
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);

        loadWallpaper();
        loadLayout();
        renderAll();
        // renderNavBar() and renderSidebar() removed — #desktop-topbar from EJS is the sole navigation
        _loadDeviceSearchCache();
        // Init canvas area baseline for proportional repositioning
        _prevCanvasArea = getCanvasArea();
    }

    function destroy() {
        stopAllTimers();
        // Close all popup windows
        _popouts.forEach(function (p, id) { _cleanupPopout(id); });
        _popouts.clear();
        _widgets.forEach(function (w) { destroyWidget(w.id, true); });
        _widgets.clear();
        if (_canvas) _canvas.innerHTML = '';
        _focusedId = null;
        removeNavBar();
        removeSidebar();
        removeAddButton();
    }

    /** Refresh all widget data by restarting their update timers. */
    function refreshAll() {
        stopAllTimers();
        _widgets.forEach(function (w) {
            startWidgetTimer(w);
        });
    }

    // ============ Wallpaper ============

    var STORAGE_WALL_FIT = 'bd_widget_wallpaper_fit';
    var DEFAULT_GRADIENT = 'linear-gradient(135deg, #0d1117 0%, #161b22 40%, #1a1a2e 70%, #0f3460 100%)';
    var _wallpapersAvailable = null; // null = unknown, true/false after probe

    function loadWallpaper() {
        var saved = localStorage.getItem(STORAGE_WALL);
        var fit = localStorage.getItem(STORAGE_WALL_FIT) || 'cover';
        if (saved) {
            // Solid colors don't need validation
            if (saved.indexOf('solid:') === 0) {
                applyWallpaper(saved, fit, false);
                return;
            }
            // Validate saved image URL exists before applying
            var probe = new Image();
            probe.onload = function() {
                _wallpapersAvailable = true;
                applyWallpaper(saved, fit, false);
            };
            probe.onerror = function() {
                // Saved wallpaper missing — clear stale preference and fall back
                localStorage.removeItem(STORAGE_WALL);
                _wallpapersAvailable = false;
                applyDefaultGradient();
            };
            probe.src = saved;
        } else {
            if (applyBrandingWallpaper(fit)) return;
            // Probe if wallpapers exist before loading default
            probeWallpapers(function(available) {
                if (available) {
                    applyWallpaper('/wallpapers/1.png', fit, false);
                } else {
                    applyDefaultGradient();
                }
            });
        }
    }

    function applyBrandingWallpaper(fit) {
        var branding = (window.BetterDesk && window.BetterDesk.branding) || {};
        var type = branding.bgType || 'none';
        if (type === 'color' && /^#[0-9a-fA-F]{6}$/.test(String(branding.bgColor || ''))) {
            applyWallpaper('solid:' + branding.bgColor, fit, false);
            localStorage.removeItem(STORAGE_WALL);
            return true;
        }
        var el = document.querySelector('.desktop-wallpaper');
        if (!el) return false;
        if (type === 'gradient' && branding.bgGradient) {
            _wallpaperPath = 'branding:gradient';
            el.style.backgroundImage = String(branding.bgGradient);
            el.style.backgroundColor = '';
            el.style.backgroundSize = 'cover';
            el.style.backgroundRepeat = 'no-repeat';
            el.style.backgroundPosition = 'center';
            return true;
        }
        if (type === 'image' && branding.bgImageUrl) {
            _wallpaperPath = branding.bgImageUrl;
            el.style.backgroundImage = 'url("' + String(branding.bgImageUrl).replace(/"/g, '%22') + '")';
            el.style.backgroundColor = '';
            applyBackgroundSizeMode(el, branding.bgSize);
            return true;
        }
        return false;
    }

    function applyBackgroundSizeMode(el, size) {
        var mode = String(size || 'cover').trim();
        if (['cover', 'contain', 'auto', 'center', 'repeat'].indexOf(mode) === -1) mode = 'cover';
        el.style.backgroundSize = (mode === 'cover' || mode === 'contain') ? mode : 'auto';
        el.style.backgroundRepeat = mode === 'repeat' ? 'repeat' : 'no-repeat';
        el.style.backgroundPosition = mode === 'repeat' ? 'top left' : 'center';
    }

    /** Check if wallpaper files are available on server */
    function probeWallpapers(cb) {
        if (_wallpapersAvailable !== null) { cb(_wallpapersAvailable); return; }
        var img = new Image();
        img.onload = function() { _wallpapersAvailable = true; cb(true); };
        img.onerror = function() { _wallpapersAvailable = false; cb(false); };
        img.src = '/wallpapers/1.png';
    }

    /** Apply default gradient when wallpapers are unavailable */
    function applyDefaultGradient() {
        var el = document.querySelector('.desktop-wallpaper');
        if (!el) return;
        _wallpaperPath = 'solid:#0d1117';
        el.style.backgroundImage = DEFAULT_GRADIENT;
        el.style.backgroundColor = '#0d1117';
        el.style.backgroundSize = 'cover';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = 'center';
    }

    /**
     * Apply wallpaper URL (or solid: prefix) with optional fit mode.
     * @param {string} url - Image URL or 'solid:#rrggbb'
     * @param {string} [fit] - 'cover' | 'contain' | 'stretch' | 'center'
     * @param {boolean} [animate] - crossfade transition (default true)
     */
    function applyWallpaper(url, fit, animate) {
        _wallpaperPath = url;
        fit = fit || 'cover';
        if (animate === undefined) animate = true;
        var el = document.querySelector('.desktop-wallpaper');
        if (!el) return;

        var isSolid = url.indexOf('solid:') === 0;

        if (isSolid) {
            var color = url.substring(6);
            el.style.backgroundImage = 'none';
            el.style.backgroundColor = color;
            el.style.backgroundSize = '';
            el.style.backgroundRepeat = '';
            el.style.backgroundPosition = '';
            localStorage.setItem(STORAGE_WALL, url);
            localStorage.setItem(STORAGE_WALL_FIT, fit);
            return;
        }

        var sizeMap = { cover: 'cover', contain: 'contain', stretch: '100% 100%', center: 'auto' };
        var posMap  = { cover: 'center', contain: 'center', stretch: 'center', center: 'center' };
        var bgSize = sizeMap[fit] || 'cover';
        var bgPos  = posMap[fit]  || 'center';

        if (!animate) {
            el.style.backgroundColor = '';
            el.style.backgroundImage = 'url("' + url + '")';
            el.style.backgroundSize = bgSize;
            el.style.backgroundRepeat = 'no-repeat';
            el.style.backgroundPosition = bgPos;
            localStorage.setItem(STORAGE_WALL, url);
            localStorage.setItem(STORAGE_WALL_FIT, fit);
            return;
        }

        var img = new Image();
        img.onload = function() {
            var newLayer = document.createElement('div');
            newLayer.className = 'desktop-wallpaper-new';
            newLayer.style.backgroundImage = 'url("' + url + '")';
            newLayer.style.backgroundSize = bgSize;
            newLayer.style.backgroundRepeat = 'no-repeat';
            newLayer.style.backgroundPosition = bgPos;
            el.appendChild(newLayer);

            requestAnimationFrame(function() {
                newLayer.classList.add('fade-in');
            });

            setTimeout(function() {
                el.style.backgroundColor = '';
                el.style.backgroundImage = 'url("' + url + '")';
                el.style.backgroundSize = bgSize;
                el.style.backgroundRepeat = 'no-repeat';
                el.style.backgroundPosition = bgPos;
                if (newLayer.parentElement) newLayer.remove();
            }, 600);
        };
        img.onerror = function() {
            // Image failed to load — fall back to gradient
            applyDefaultGradient();
            localStorage.removeItem(STORAGE_WALL);
        };
        img.src = url;

        localStorage.setItem(STORAGE_WALL, url);
        localStorage.setItem(STORAGE_WALL_FIT, fit);
    }

    /** Legacy wrapper — keeps external API backward-compatible. */
    function setWallpaper(url) {
        var fit = localStorage.getItem(STORAGE_WALL_FIT) || 'cover';
        applyWallpaper(url, fit, true);
    }

    // ============ Layout Persistence ============

    function loadLayout() {
        try {
            var savedVer = parseInt(localStorage.getItem(STORAGE_LAYOUT_VER), 10) || 1;
            var raw = localStorage.getItem(STORAGE_LAYOUT);
            // Reset to default layout on version upgrade or first visit
            if (savedVer < LAYOUT_VERSION || !raw) {
                localStorage.removeItem(STORAGE_LAYOUT);
                localStorage.setItem(STORAGE_LAYOUT_VER, String(LAYOUT_VERSION));
                var defaults = getDefaultLayout();
                defaults.forEach(function (item) {
                    _widgets.set(item.id, item);
                    if (item.z > _zCounter) _zCounter = item.z;
                });
                saveLayout();
                return;
            }
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            arr.forEach(function (item) {
                if (item && item.id && item.type) {
                    _widgets.set(item.id, item);
                    if (item.z > _zCounter) _zCounter = item.z;
                }
            });
        } catch (_) { /* ignore corrupt data */ }
    }

    function layoutPersistenceEnabled() {
        return document.body.classList.contains('desktop-active') || _widgets.size > 0;
    }

    var _saveTimeout = null;
    function saveLayout() {
        if (!layoutPersistenceEnabled()) return;
        clearTimeout(_saveTimeout);
        _saveTimeout = setTimeout(function () {
            var arr = [];
            _widgets.forEach(function (w) { arr.push(w); });
            localStorage.setItem(STORAGE_LAYOUT, JSON.stringify(arr));
            // Optional: save to server
            saveLayoutToServer(arr);
        }, SAVE_DEBOUNCE);
    }

    function saveLayoutToServer(arr) {
        if (!layoutPersistenceEnabled()) return;
        if (!window.BetterDesk || !window.BetterDesk.csrfToken) return;
        if (typeof Utils === 'undefined' || !Utils.api) return;
        Utils.api('/api/desktop/layout', {
            method: 'POST',
            body: JSON.stringify({ widgets: arr, wallpaper: _wallpaperPath })
        }).catch(function () { /* silent — localStorage is primary */ });
    }

    // ============ Widget CRUD ============

    function addWidget(type, config) {
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(type);
        if (!plugin) return null;

        var def = plugin.defaultSize || { w: 240, h: 200 };
        var area = getCanvasArea();
        var id = uid();

        // Find open position
        var pos = findOpenPosition(def.w, def.h, area);

        var w = {
            id: id,
            type: type,
            x: pos.x,
            y: pos.y,
            w: def.w,
            h: def.h,
            z: ++_zCounter,
            config: config || {}
        };

        _widgets.set(id, w);
        renderWidget(w);
        focusWidget(id);
        saveLayout();
        startWidgetTimer(w);
        return id;
    }

    function removeWidget(id) {
        // Close popup if widget is popped out
        if (_popouts.has(id)) _cleanupPopout(id);

        var el = document.getElementById(id);
        if (el) {
            el.classList.remove('widget-entering');
            el.classList.add('widget-leaving');
            el.addEventListener('animationend', function () { el.remove(); }, { once: true });
        }

        var plugin = getPlugin(id);
        if (plugin && plugin.destroy) {
            var body = el ? el.querySelector('.widget-body') : null;
            try { plugin.destroy(body); } catch (_) {}
        }

        stopWidgetTimer(id);
        _widgets.delete(id);
        if (_focusedId === id) _focusedId = null;
        saveLayout();
    }

    function destroyWidget(id, immediate) {
        stopWidgetTimer(id);
        var el = document.getElementById(id);
        if (el) {
            var plugin = getPlugin(id);
            if (plugin && plugin.destroy) {
                var body = el.querySelector('.widget-body');
                try { plugin.destroy(body); } catch (_) {}
            }
            el.remove();
        }
    }

    // ============ Rendering ============

    function renderAll() {
        if (!_canvas) return;
        _canvas.innerHTML = '';
        var idx = 0;
        _widgets.forEach(function (w) {
            renderWidget(w);
            // Stagger initial data fetches to avoid 429 rate limit storm
            (function (widget, delay) {
                setTimeout(function () { startWidgetTimer(widget); }, delay);
            })(w, idx * 200);
            idx++;
        });
        renderAddButton();
    }

    function renderWidget(w) {
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        if (!plugin) return;

        var el = document.createElement('div');
        el.className = 'desktop-widget widget-entering';
        el.id = w.id;
        el.style.left = w.x + 'px';
        el.style.top = w.y + 'px';
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
        el.style.zIndex = w.z;
        el.setAttribute('data-widget-type', w.type);

        var iconColor = plugin.color || '#58a6ff';

        el.innerHTML =
            '<div class="widget-header">' +
                '<div class="widget-header-icon" style="color:' + esc(iconColor) + '">' +
                    '<span class="material-icons">' + esc(plugin.icon || 'widgets') + '</span>' +
                '</div>' +
                '<div class="widget-header-title">' + esc(plugin.name || w.type) + '</div>' +
                '<div class="widget-header-actions">' +
                    '<button class="widget-btn-kebab" title="Options">' +
                        '<span class="material-icons">more_vert</span>' +
                    '</button>' +
                    '<div class="widget-kebab-menu">' +
                        '<div class="widget-kebab-item" data-action="config"><span class="material-icons">settings</span>' + esc(t('desktop.configure')) + '</div>' +
                        '<div class="widget-kebab-item" data-action="refresh"><span class="material-icons">refresh</span>' + esc(t('desktop.refresh')) + '</div>' +
                        '<div class="widget-kebab-item" data-action="popout"><span class="material-icons">open_in_new</span>' + esc(t('desktop.pop_out_widget')) + '</div>' +
                        '<div class="widget-kebab-divider"></div>' +
                        '<div class="widget-kebab-item danger" data-action="remove"><span class="material-icons">delete</span>' + esc(t('desktop.remove_widget')) + '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="widget-body"></div>' +
            buildResizeHandles();

        // Events
        el.addEventListener('mousedown', function (e) {
            if (!e.target.closest('.widget-header-actions')) focusWidget(w.id);
        });

        // Drag via header
        var header = el.querySelector('.widget-header');
        header.addEventListener('mousedown', function (e) {
            if (e.target.closest('.widget-header-actions')) return;
            startDrag(w.id, e);
        });
        header.addEventListener('touchstart', function (e) {
            if (e.target.closest('.widget-header-actions')) return;
            startDrag(w.id, e);
        }, { passive: false });

        // Kebab menu toggle
        var kebabBtn = el.querySelector('.widget-btn-kebab');
        var kebabMenu = el.querySelector('.widget-kebab-menu');
        kebabBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _closeAllKebabMenus(el);
            kebabMenu.classList.toggle('open');
        });

        // Kebab menu actions
        el.querySelectorAll('.widget-kebab-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                kebabMenu.classList.remove('open');
                var action = item.dataset.action;
                if (action === 'remove') removeWidget(w.id);
                else if (action === 'config') openWidgetConfig(w.id);
                else if (action === 'popout') popOutWidget(w.id);
                else if (action === 'refresh') {
                    var p = getPlugin(w.id);
                    if (p && p.update) {
                        var b = document.getElementById(w.id);
                        if (b) try { p.update(b.querySelector('.widget-body')); } catch (_) {}
                    }
                }
            });
        });

        // Resize handles
        el.querySelectorAll('.widget-resize').forEach(function (handle) {
            handle.addEventListener('mousedown', function (e) {
                e.stopPropagation();
                startResize(w.id, e, handle.dataset.dir);
            });
            handle.addEventListener('touchstart', function (e) {
                e.stopPropagation();
                startResize(w.id, e, handle.dataset.dir);
            }, { passive: false });
        });

        _canvas.appendChild(el);

        // Render plugin content
        var body = el.querySelector('.widget-body');
        if (plugin.render) {
            try { plugin.render(body, w.config, w); } catch (err) {
                body.innerHTML = '<div class="widget-empty"><span class="material-icons">error</span><span>Error</span></div>';
                console.error('[Widget] render error (' + w.type + '):', err);
            }
        }
    }

    function buildResizeHandles() {
        var dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        return dirs.map(function (d) {
            return '<div class="widget-resize widget-resize-' + d + '" data-dir="' + d + '"></div>';
        }).join('');
    }

    function renderAddButton() {
        var existing = document.querySelector('.widget-add-btn');
        if (existing) existing.remove();
        // Skip FAB when topnav provides the + button
        if (document.querySelector('.widget-topnav')) return;

        var btn = document.createElement('button');
        btn.className = 'widget-add-btn';
        btn.title = t('desktop.add_widget');
        btn.innerHTML = '<span class="material-icons">add</span>';
        btn.addEventListener('click', function () { togglePicker(); });
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(btn);
    }

    function removeAddButton() {
        var btn = document.querySelector('.widget-add-btn');
        if (btn) btn.remove();
    }

    // ============ Focus ============

    function focusWidget(id) {
        if (_focusedId === id) return;
        // Unfocus previous
        if (_focusedId) {
            var prev = document.getElementById(_focusedId);
            if (prev) prev.classList.remove('widget-focused');
        }
        _focusedId = id;
        var w = _widgets.get(id);
        if (!w) return;
        w.z = ++_zCounter;
        var el = document.getElementById(id);
        if (el) {
            el.style.zIndex = w.z;
            el.classList.add('widget-focused');
        }
    }

    function unfocus() {
        if (_focusedId) {
            var el = document.getElementById(_focusedId);
            if (el) el.classList.remove('widget-focused');
            _focusedId = null;
        }
    }

    // ============ Drag ============

    function startDrag(id, e) {
        var w = _widgets.get(id);
        if (!w) return;

        var clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
            e.preventDefault();
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
            e.preventDefault();
        }

        focusWidget(id);

        _dragState = {
            id: id,
            startX: clientX,
            startY: clientY,
            origX: w.x,
            origY: w.y
        };

        var el = document.getElementById(id);
        if (el) el.classList.add('widget-dragging');
    }

    var _widgetRafPending = false;
    var _widgetLastMove = null;

    function onMouseMove(e) {
        if (!_dragState && !_resizeState) return;
        _widgetLastMove = { cx: e.clientX, cy: e.clientY };
        if (_widgetRafPending) return;
        _widgetRafPending = true;
        requestAnimationFrame(function () {
            _widgetRafPending = false;
            if (!_widgetLastMove) return;
            var m = _widgetLastMove;
            if (_dragState) handleDragMove(m.cx, m.cy);
            if (_resizeState) handleResizeMove(m.cx, m.cy);
        });
    }

    function onTouchMove(e) {
        if (!_dragState && !_resizeState) return;
        e.preventDefault();
        var touch = e.touches[0];
        if (_dragState) handleDragMove(touch.clientX, touch.clientY);
        if (_resizeState) handleResizeMove(touch.clientX, touch.clientY);
    }

    function handleDragMove(cx, cy) {
        var s = _dragState;
        var w = _widgets.get(s.id);
        if (!w) return;

        var area = getCanvasArea();
        var edges = getSnapEdges(s.id);
        var rawX = s.origX + (cx - s.startX);
        var rawY = s.origY + (cy - s.startY);
        w.x = clamp(edgeSnap(rawX, edges.x), 0, Math.max(area.w - w.w, 0));
        w.y = clamp(edgeSnap(rawY, edges.y), 0, Math.max(area.h - w.h, 0));

        var el = document.getElementById(s.id);
        if (el) {
            el.style.left = w.x + 'px';
            el.style.top = w.y + 'px';
        }
    }

    function onMouseUp() { endInteraction(); }
    function onTouchEnd() { endInteraction(); }

    function endInteraction() {
        if (_dragState) {
            var el = document.getElementById(_dragState.id);
            if (el) el.classList.remove('widget-dragging');
            _dragState = null;
            saveLayout();
        }
        if (_resizeState) {
            var el = document.getElementById(_resizeState.id);
            if (el) el.classList.remove('widget-resizing');
            _resizeState = null;
            saveLayout();
        }
    }

    // ============ Resize ============

    function startResize(id, e, dir) {
        var w = _widgets.get(id);
        if (!w) return;

        var cx, cy;
        if (e.touches) {
            cx = e.touches[0].clientX;
            cy = e.touches[0].clientY;
            e.preventDefault();
        } else {
            cx = e.clientX;
            cy = e.clientY;
            e.preventDefault();
        }

        focusWidget(id);
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        var minW = (plugin && plugin.minSize && plugin.minSize.w) || MIN_W;
        var minH = (plugin && plugin.minSize && plugin.minSize.h) || MIN_H;

        _resizeState = {
            id: id,
            dir: dir,
            startX: cx,
            startY: cy,
            origX: w.x,
            origY: w.y,
            origW: w.w,
            origH: w.h,
            minW: minW,
            minH: minH
        };

        var el = document.getElementById(id);
        if (el) el.classList.add('widget-resizing');
    }

    function handleResizeMove(cx, cy) {
        var s = _resizeState;
        var w = _widgets.get(s.id);
        if (!w) return;

        var dx = cx - s.startX;
        var dy = cy - s.startY;
        var dir = s.dir;
        var nw = w.w, nh = w.h, nx = w.x, ny = w.y;

        if (dir.indexOf('e') !== -1) nw = Math.max(s.minW, snap(s.origW + dx));
        if (dir.indexOf('s') !== -1) nh = Math.max(s.minH, snap(s.origH + dy));
        if (dir.indexOf('w') !== -1) {
            var pw = snap(s.origW - dx);
            if (pw >= s.minW) { nw = pw; nx = s.origX + (s.origW - pw); }
        }
        if (dir.indexOf('n') !== -1) {
            var ph = snap(s.origH - dy);
            if (ph >= s.minH) { nh = ph; ny = s.origY + (s.origH - ph); }
        }

        w.x = nx; w.y = ny; w.w = nw; w.h = nh;

        var el = document.getElementById(s.id);
        if (el) {
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
            el.style.width = nw + 'px';
            el.style.height = nh + 'px';
        }
    }

    // ============ Widget Data Updates ============

    function startWidgetTimer(w) {
        stopWidgetTimer(w.id);
        var plugin = getPlugin(w.id);
        if (!plugin || !plugin.update) return;
        var interval = plugin.updateInterval || UPDATE_INTERVAL;

        // Immediate first update
        updateWidgetData(w.id);

        var timer = setInterval(function () { updateWidgetData(w.id); }, interval);
        _updateTimers.set(w.id, timer);
    }

    function stopWidgetTimer(id) {
        var timer = _updateTimers.get(id);
        if (timer) {
            clearInterval(timer);
            _updateTimers.delete(id);
        }
    }

    function stopAllTimers() {
        _updateTimers.forEach(function (timer) { clearInterval(timer); });
        _updateTimers.clear();
    }

    function updateWidgetData(id) {
        var w = _widgets.get(id);
        if (!w) return;
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        if (!plugin || !plugin.update) return;

        var el = document.getElementById(id);
        if (!el) return;
        var body = el.querySelector('.widget-body');
        if (!body) return;

        try { plugin.update(body, w.config, w); } catch (err) {
            console.error('[Widget] update error (' + w.type + '):', err);
        }
    }

    // ============ Utility ============

    function getPlugin(widgetId) {
        var w = _widgets.get(widgetId);
        if (!w) return null;
        return window.WidgetPlugins && window.WidgetPlugins.get(w.type);
    }

    function getCanvasArea() {
        if (_canvas) {
            return { w: _canvas.offsetWidth, h: _canvas.offsetHeight };
        }
        // Fallback: topbar 36px, taskbar 10px
        return { w: window.innerWidth, h: window.innerHeight - 46 };
    }

    function findOpenPosition(w, h, area) {
        // Simple spiral search for open spot
        for (var row = 0; row < area.h - h; row += GRID * 4) {
            for (var col = 0; col < area.w - w; col += GRID * 4) {
                if (!isOverlapping(col, row, w, h)) {
                    return { x: col + 20, y: row + 20 };
                }
            }
        }
        // Fallback: random position
        return {
            x: snap(Math.random() * Math.max(0, area.w - w)),
            y: snap(Math.random() * Math.max(0, area.h - h))
        };
    }

    function isOverlapping(x, y, w, h) {
        var found = false;
        _widgets.forEach(function (wg) {
            if (found) return;
            if (x < wg.x + wg.w && x + w > wg.x && y < wg.y + wg.h && y + h > wg.y) {
                found = true;
            }
        });
        return found;
    }

    // ============ Widget Picker ============

    function togglePicker() {
        if (_pickerOpen) {
            closePicker();
        } else {
            openPicker();
        }
    }

    function openPicker() {
        closePicker();
        _pickerOpen = true;

        if (!window.WidgetPlugins) return;
        var plugins = window.WidgetPlugins.list();

        // Group by category
        var categories = {};
        plugins.forEach(function (p) {
            var cat = p.category || 'general';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(p);
        });

        var panel = document.createElement('div');
        panel.className = 'widget-picker';
        panel.id = 'widget-picker';

        var html = '<div class="widget-picker-header">' +
            '<h3>' + esc(t('desktop.add_widget')) + '</h3>' +
            '<div class="widget-picker-search-wrap">' +
                '<span class="material-icons">search</span>' +
                '<input class="widget-picker-search" placeholder="' + esc(t('desktop.search_widgets')) + '">' +
            '</div>' +
        '</div>' +
        '<div class="widget-picker-list">';

        var catOrder = ['monitoring', 'devices', 'tools', 'general'];
        catOrder.forEach(function (cat) {
            var items = categories[cat];
            if (!items || !items.length) return;
            html += '<div class="widget-picker-category">' + esc(t('desktop.cat_' + cat)) + '</div>';
            items.forEach(function (p) {
                html += '<div class="widget-picker-item" data-type="' + esc(p.type) + '">' +
                    '<div class="widget-picker-item-icon" style="background:' + esc(p.color || '#58a6ff') + '22;color:' + esc(p.color || '#58a6ff') + '">' +
                        '<span class="material-icons">' + esc(p.icon) + '</span>' +
                    '</div>' +
                    '<div class="widget-picker-item-info">' +
                        '<div class="widget-picker-item-name">' + esc(p.name) + '</div>' +
                        '<div class="widget-picker-item-desc">' + esc(p.description || '') + '</div>' +
                    '</div>' +
                '</div>';
            });
        });

        html += '</div>';
        panel.innerHTML = html;

        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(panel);

        // Search filter
        var searchInput = panel.querySelector('.widget-picker-search');
        searchInput.addEventListener('input', function () {
            var q = searchInput.value.toLowerCase();
            panel.querySelectorAll('.widget-picker-item').forEach(function (item) {
                var name = item.querySelector('.widget-picker-item-name').textContent.toLowerCase();
                var desc = item.querySelector('.widget-picker-item-desc').textContent.toLowerCase();
                item.style.display = (name.indexOf(q) !== -1 || desc.indexOf(q) !== -1) ? '' : 'none';
            });
            // Hide empty categories
            panel.querySelectorAll('.widget-picker-category').forEach(function (cat) {
                var next = cat.nextElementSibling;
                var hasVisible = false;
                while (next && !next.classList.contains('widget-picker-category')) {
                    if (next.style.display !== 'none') hasVisible = true;
                    next = next.nextElementSibling;
                }
                cat.style.display = hasVisible ? '' : 'none';
            });
        });

        // Click handler for items
        panel.querySelectorAll('.widget-picker-item').forEach(function (item) {
            item.addEventListener('click', function () {
                addWidget(item.dataset.type);
                closePicker();
            });
        });

        // Close on outside click
        setTimeout(function () {
            function handleOutside(e) {
                if (!panel.contains(e.target) && !e.target.closest('.widget-add-btn')) {
                    closePicker();
                    document.removeEventListener('mousedown', handleOutside);
                }
            }
            document.addEventListener('mousedown', handleOutside);
        }, 10);
    }

    function closePicker() {
        _pickerOpen = false;
        var panel = document.getElementById('widget-picker');
        if (panel) panel.remove();
    }

    // ============ Widget Config Modal ============

    function openWidgetConfig(id) {
        var w = _widgets.get(id);
        if (!w) return;
        var plugin = getPlugin(id);
        if (!plugin || !plugin.configForm) return;

        var fields = plugin.configForm(w.config);
        if (!fields || !fields.length) return;

        var overlay = document.createElement('div');
        overlay.className = 'widget-config-overlay';
        overlay.id = 'widget-config-overlay';

        var html = '<div class="widget-config-panel">' +
            '<h3>' + esc(plugin.name) + ' — ' + esc(t('desktop.configure')) + '</h3>';

        fields.forEach(function (f) {
            html += '<div class="widget-config-field">';
            html += '<label>' + esc(f.label) + '</label>';
            if (f.type === 'select') {
                html += '<select name="' + esc(f.key) + '">';
                (f.options || []).forEach(function (opt) {
                    var sel = (w.config[f.key] === opt.value) ? ' selected' : '';
                    html += '<option value="' + esc(opt.value) + '"' + sel + '>' + esc(opt.label) + '</option>';
                });
                html += '</select>';
            } else if (f.type === 'textarea') {
                html += '<textarea name="' + esc(f.key) + '" rows="4">' + esc(w.config[f.key] || '') + '</textarea>';
            } else {
                html += '<input type="' + (f.type || 'text') + '" name="' + esc(f.key) + '" value="' + esc(w.config[f.key] || '') + '">';
            }
            html += '</div>';
        });

        html += '<div class="widget-config-actions">' +
            '<button class="widget-config-btn-cancel">' + esc(t('common.cancel')) + '</button>' +
            '<button class="widget-config-btn-save">' + esc(t('common.save')) + '</button>' +
        '</div></div>';

        overlay.innerHTML = html;
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(overlay);

        // Cancel
        overlay.querySelector('.widget-config-btn-cancel').addEventListener('click', function () {
            overlay.remove();
        });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

        // Save
        overlay.querySelector('.widget-config-btn-save').addEventListener('click', function () {
            fields.forEach(function (f) {
                var input = overlay.querySelector('[name="' + f.key + '"]');
                if (input) w.config[f.key] = input.value;
            });
            overlay.remove();
            saveLayout();

            // Re-render widget body
            var el = document.getElementById(id);
            if (el && plugin.render) {
                var body = el.querySelector('.widget-body');
                if (body) {
                    body.innerHTML = '';
                    try { plugin.render(body, w.config, w); } catch (_) {}
                }
            }
            // Trigger update
            updateWidgetData(id);
        });
    }

    // ============ Wallpaper Picker ============

    var _pickerObserver = null;

    function openWallpaperPicker() {
        if (_wallpicker) return;
        _wallpicker = true;

        var currentFit = localStorage.getItem(STORAGE_WALL_FIT) || 'cover';
        var isSolid = _wallpaperPath && _wallpaperPath.indexOf('solid:') === 0;
        var currentColor = isSolid ? _wallpaperPath.substring(6) : '#1a1a2e';

        var overlay = document.createElement('div');
        overlay.className = 'wallpaper-picker-overlay';
        overlay.id = 'wallpaper-picker-overlay';

        // Predefined solid colors
        var solidColors = [
            '#0d1117', '#161b22', '#1a1a2e', '#0f3460',
            '#16213e', '#1b2838', '#2d3436', '#1e272e',
            '#2c3e50', '#34495e', '#1c1c1c', '#212121',
            '#263238', '#37474f', '#102027', '#004d40',
            '#1b5e20', '#b71c1c', '#4a148c', '#311b92'
        ];

        var html = '<div class="wallpaper-picker">' +
            '<div class="wallpaper-picker-header">' +
                '<h3>' + esc(t('desktop.wallpaper')) + '</h3>' +
                '<button class="wallpaper-picker-close"><span class="material-icons">close</span></button>' +
            '</div>' +
            '<div class="wallpaper-picker-tabs">' +
                '<button class="wp-tab active" data-tab="images">' +
                    '<span class="material-icons">image</span> ' + esc(t('desktop.wp_images')) +
                '</button>' +
                '<button class="wp-tab" data-tab="colors">' +
                    '<span class="material-icons">palette</span> ' + esc(t('desktop.wp_colors')) +
                '</button>' +
            '</div>' +
            '<div class="wallpaper-picker-body">' +
                '<div class="wp-panel" id="wp-panel-images">' +
                    '<div class="wallpaper-grid" id="wallpaper-grid"></div>' +
                '</div>' +
                '<div class="wp-panel" id="wp-panel-colors" style="display:none">' +
                    '<div class="wp-color-grid">' +
                        solidColors.map(function(c) {
                            var sel = (isSolid && currentColor === c) ? ' active' : '';
                            return '<button class="wp-color-swatch' + sel + '" data-color="' + c + '" ' +
                                'style="background:' + c + '" title="' + c + '"></button>';
                        }).join('') +
                    '</div>' +
                    '<div class="wp-custom-color">' +
                        '<label>' + esc(t('desktop.wp_custom_color')) + '</label>' +
                        '<input type="color" id="wp-custom-color-input" value="' + esc(currentColor) + '">' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="wallpaper-picker-footer">' +
                '<div class="wp-fit-selector">' +
                    '<label>' + esc(t('desktop.wp_fit_style')) + '</label>' +
                    '<select id="wp-fit-select">' +
                        '<option value="cover"' + (currentFit === 'cover' ? ' selected' : '') + '>' + esc(t('desktop.wp_fill')) + '</option>' +
                        '<option value="contain"' + (currentFit === 'contain' ? ' selected' : '') + '>' + esc(t('desktop.wp_fit')) + '</option>' +
                        '<option value="stretch"' + (currentFit === 'stretch' ? ' selected' : '') + '>' + esc(t('desktop.wp_stretch')) + '</option>' +
                        '<option value="center"' + (currentFit === 'center' ? ' selected' : '') + '>' + esc(t('desktop.wp_center')) + '</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
        '</div>';
        overlay.innerHTML = html;
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(overlay);

        // Close handlers
        overlay.querySelector('.wallpaper-picker-close').addEventListener('click', closeWallpaperPicker);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeWallpaperPicker();
        });

        // Tab switching
        overlay.querySelectorAll('.wp-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                overlay.querySelectorAll('.wp-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var target = tab.dataset.tab;
                overlay.querySelectorAll('.wp-panel').forEach(function(p) { p.style.display = 'none'; });
                var panel = document.getElementById('wp-panel-' + target);
                if (panel) panel.style.display = '';
            });
        });

        // Fit mode change — apply immediately if a wallpaper is already set
        var fitSelect = overlay.querySelector('#wp-fit-select');
        fitSelect.addEventListener('change', function() {
            if (_wallpaperPath) {
                applyWallpaper(_wallpaperPath, fitSelect.value, false);
            }
        });

        // Solid color swatches
        overlay.querySelectorAll('.wp-color-swatch').forEach(function(swatch) {
            swatch.addEventListener('click', function() {
                overlay.querySelectorAll('.wp-color-swatch.active').forEach(function(a) { a.classList.remove('active'); });
                swatch.classList.add('active');
                applyWallpaper('solid:' + swatch.dataset.color, fitSelect.value, false);
            });
        });

        // Custom color input
        var customColor = overlay.querySelector('#wp-custom-color-input');
        customColor.addEventListener('input', function() {
            overlay.querySelectorAll('.wp-color-swatch.active').forEach(function(a) { a.classList.remove('active'); });
            applyWallpaper('solid:' + customColor.value, fitSelect.value, false);
        });

        // Image grid
        var grid = overlay.querySelector('#wallpaper-grid');
        var frag = document.createDocumentFragment();

        // Show wallpapers availability message
        function showWallpaperNotice(grid) {
            var notice = document.createElement('div');
            notice.className = 'wallpaper-unavailable-notice';
            notice.innerHTML =
                '<span class="material-icons">info</span>' +
                '<p>' + esc(t('desktop.wp_unavailable')) + '</p>' +
                '<small>' + esc(t('desktop.wp_download_hint')) + '</small>';
            grid.appendChild(notice);
        }

        probeWallpapers(function(available) {
            if (!available) {
                showWallpaperNotice(grid);
                return;
            }
            var innerFrag = document.createDocumentFragment();
            for (var j = 1; j <= WALLPAPER_COUNT; j++) {
                var wPath = '/wallpapers/' + j + '.png';
                var tPath = '/wallpapers/thumbs/' + j + '.webp';
                var act = (!isSolid && _wallpaperPath === wPath) ? ' active' : '';
                var th = document.createElement('div');
                th.className = 'wallpaper-thumb' + act;
                th.dataset.path = wPath;
                th.dataset.thumb = tPath;
                th.dataset.idx = String(j);
                th.innerHTML = '<div class="wallpaper-thumb-placeholder"><span>' + j + '</span></div>';
                innerFrag.appendChild(th);
            }
            grid.appendChild(innerFrag);

            // Attach click + lazy load for dynamically added thumbnails
            attachWallpaperGridEvents(grid, fitSelect);
        });

        // Single click handler via event delegation
        grid.addEventListener('click', function (e) {
            var el = e.target.closest('.wallpaper-thumb');
            if (!el || !el.dataset.path) return;
            grid.querySelectorAll('.wallpaper-thumb.active').forEach(function (a) { a.classList.remove('active'); });
            el.classList.add('active');
            applyWallpaper(el.dataset.path, fitSelect.value, true);
            closeWallpaperPicker();
        });

        function attachWallpaperGridEvents(targetGrid, fitSel) {
            // Helper: create thumbnail <img> with fallback to full PNG on error
            function createThumbImg(el) {
                var img = document.createElement('img');
                img.onload = function () { img.classList.add('loaded'); };
                img.onerror = function () {
                    if (img.src.indexOf(el.dataset.path) === -1) {
                        img.src = el.dataset.path;
                    } else {
                        // Both thumb and full image failed — show placeholder
                        img.classList.add('loaded');
                        img.style.display = 'none';
                    }
                };
                img.src = el.dataset.thumb;
                img.alt = 'Wallpaper ' + el.dataset.idx;
                img.loading = 'lazy';
                img.decoding = 'async';
                return img;
            }

            // Lazy-load thumbnails via IntersectionObserver
            if ('IntersectionObserver' in window) {
                _pickerObserver = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (!entry.isIntersecting) return;
                        var el = entry.target;
                        var ph = el.querySelector('.wallpaper-thumb-placeholder');
                        if (!ph) { _pickerObserver.unobserve(el); return; }
                        el.replaceChild(createThumbImg(el), ph);
                        _pickerObserver.unobserve(el);
                    });
                }, { root: targetGrid, rootMargin: '300px' });

                targetGrid.querySelectorAll('.wallpaper-thumb').forEach(function (el) {
                    _pickerObserver.observe(el);
                });
            } else {
                targetGrid.querySelectorAll('.wallpaper-thumb').forEach(function (el) {
                    var ph = el.querySelector('.wallpaper-thumb-placeholder');
                    if (!ph) return;
                    el.replaceChild(createThumbImg(el), ph);
                });
            }
        }

        // If currently on solid color, auto-switch to colors tab
        if (isSolid) {
            var colorsTab = overlay.querySelector('.wp-tab[data-tab="colors"]');
            if (colorsTab) colorsTab.click();
        }
    }

    function closeWallpaperPicker() {
        _wallpicker = false;
        if (_pickerObserver) {
            _pickerObserver.disconnect();
            _pickerObserver = null;
        }
        var overlay = document.getElementById('wallpaper-picker-overlay');
        if (overlay) overlay.remove();
    }

    // ============ Navigation Bar & Sidebar ============

    function renderNavBar() {
        if (document.querySelector('.widget-topnav')) return;
        var nav = document.createElement('div');
        nav.className = 'widget-topnav';
        nav.innerHTML =
            '<button class="topnav-menu" id="topnav-menu-btn" title="Menu"><span class="material-icons">menu</span></button>' +
            '<div class="topnav-brand">BetterDesk</div>' +
            '<div class="topnav-tabs">' +
                '<button class="topnav-tab active" data-route="/" title="' + esc(t('nav.dashboard') || 'Dashboard') + '"><span class="material-icons">home</span></button>' +
                '<button class="topnav-tab" data-route="/devices" title="' + esc(t('nav.devices') || 'Devices') + '"><span class="material-icons">devices</span></button>' +
                '<button class="topnav-tab" data-route="/inventory" title="' + esc(t('inventory.title') || 'Inventory') + '"><span class="material-icons">inventory_2</span></button>' +
                '<button class="topnav-tab" data-route="/tickets" title="' + esc(t('tickets.title') || 'Helpdesk') + '"><span class="material-icons">support_agent</span></button>' +
                '<button class="topnav-tab" data-route="/automation" title="' + esc(t('automation.title') || 'Automation') + '"><span class="material-icons">smart_toy</span></button>' +
                '<button class="topnav-tab" data-route="/network" title="' + esc(t('network.title') || 'Network') + '"><span class="material-icons">wifi</span></button>' +
                '<button class="topnav-tab" data-route="/reports" title="' + esc(t('reports.title') || 'Reports') + '"><span class="material-icons">assessment</span></button>' +
                '<button class="topnav-tab" data-route="/keys" title="' + esc(t('nav.keys') || 'Keys') + '"><span class="material-icons">vpn_key</span></button>' +
                '<button class="topnav-tab" data-route="/cdap/devices" title="CDAP"><span class="material-icons">developer_board</span></button>' +
                '<button class="topnav-tab" data-route="/tokens" title="' + esc(t('nav.tokens') || 'Tokens') + '"><span class="material-icons">token</span></button>' +
                '<button class="topnav-tab" data-route="/settings" title="' + esc(t('nav.settings') || 'Settings') + '"><span class="material-icons">settings</span></button>' +
            '</div>' +
            '<div class="topnav-sep"></div>' +
            '<div class="topnav-actions">' +
                '<button class="topnav-btn" id="topnav-search" title="Search"><span class="material-icons">search</span></button>' +
                '<button class="topnav-btn" id="topnav-add" title="' + esc(t('desktop.add_widget') || 'Add Widget') + '"><span class="material-icons">add</span></button>' +
                '<button class="topnav-btn" id="topnav-edit" title="Edit"><span class="material-icons">edit</span></button>' +
                '<button class="topnav-btn" id="topnav-help" title="Help"><span class="material-icons">help_outline</span></button>' +
            '</div>' +
            '<div class="topnav-clock" id="topnav-clock"></div>' +
            '<button class="topnav-btn topnav-exit" id="topnav-exit" title="' + esc(t('desktop.exit_desktop') || 'Exit Desktop') + '"><span class="material-icons">logout</span></button>';
        var shell = document.getElementById('desktop-shell');
        if (shell) shell.appendChild(nav);
        // Tab navigation — open as float window if DesktopMode has openApp
        nav.querySelectorAll('.topnav-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var route = tab.dataset.route;
                if (!route) return;
                if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                    window.DesktopMode.openAppByRoute(route);
                } else {
                    window.location.href = route;
                }
            });
        });
        // Add widget button
        var addBtn = nav.querySelector('#topnav-add');
        if (addBtn) addBtn.addEventListener('click', function () { togglePicker(); });
        // Edit mode toggle
        var editBtn = nav.querySelector('#topnav-edit');
        if (editBtn) editBtn.addEventListener('click', function () {
            editBtn.classList.toggle('active');
            document.body.classList.toggle('widget-edit-mode');
        });
        // Help button — start desktop tutorial
        var helpBtn = nav.querySelector('#topnav-help');
        if (helpBtn) helpBtn.addEventListener('click', function () {
            if (window.BetterDeskTutorial) window.BetterDeskTutorial.start('desktop');
        });
        // Exit desktop mode
        var exitBtn = nav.querySelector('#topnav-exit');
        if (exitBtn) exitBtn.addEventListener('click', function () {
            if (window.DesktopMode) window.DesktopMode.deactivate();
        });
        // Menu button — toggle sidebar visibility
        var menuBtn = nav.querySelector('#topnav-menu-btn');
        if (menuBtn) menuBtn.addEventListener('click', function () {
            var sb = document.querySelector('.widget-sidebar');
            if (!sb) return;
            sb.classList.toggle('sidebar-collapsed');
            menuBtn.classList.toggle('active', !sb.classList.contains('sidebar-collapsed'));
            // Adjust canvas inset
            var cn = document.querySelector('.widget-canvas');
            if (cn) cn.style.left = sb.classList.contains('sidebar-collapsed') ? '0' : '';
        });
        // Search button — open search overlay
        var searchBtn = nav.querySelector('#topnav-search');
        if (searchBtn) searchBtn.addEventListener('click', function () { _openSearchOverlay(); });
        // Start topnav clock
        _startTopnavClock();
    }

    function removeNavBar() {
        _stopTopnavClock();
        var nav = document.querySelector('.widget-topnav');
        if (nav) nav.remove();
    }

    var _topnavClockTimer = null;
    function _startTopnavClock() {
        _updateTopnavClock();
        _topnavClockTimer = setInterval(_updateTopnavClock, 1000);
    }
    function _stopTopnavClock() {
        if (_topnavClockTimer) { clearInterval(_topnavClockTimer); _topnavClockTimer = null; }
    }
    function _updateTopnavClock() {
        var el = document.getElementById('topnav-clock');
        if (!el) return;
        var now = new Date();
        var h = String(now.getHours()).padStart(2, '0');
        var m = String(now.getMinutes()).padStart(2, '0');
        el.textContent = h + ':' + m;
    }

    // ============ Search Overlay ============

    function _openSearchOverlay() {
        if (document.getElementById('widget-search-overlay')) return;
        var overlay = document.createElement('div');
        overlay.id = 'widget-search-overlay';
        overlay.className = 'widget-search-overlay';
        overlay.innerHTML =
            '<div class="ws-dialog">' +
                '<div class="ws-header">' +
                    '<span class="material-icons">search</span>' +
                    '<input id="ws-input" type="text" placeholder="' + esc(t('desktop.search_placeholder') || 'Search devices, pages, settings...') + '" autocomplete="off" />' +
                    '<button class="ws-close" id="ws-close"><span class="material-icons">close</span></button>' +
                '</div>' +
                '<div class="ws-results" id="ws-results"></div>' +
            '</div>';
        document.body.appendChild(overlay);
        var input = document.getElementById('ws-input');
        var results = document.getElementById('ws-results');
        if (input) {
            input.focus();
            input.addEventListener('input', Utils.debounce(function () { _runSearch(input.value.trim(), results); }, 200));
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') _closeSearchOverlay();
            });
        }
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) _closeSearchOverlay();
        });
        var closeBtn = document.getElementById('ws-close');
        if (closeBtn) closeBtn.addEventListener('click', _closeSearchOverlay);
        // Show quick-access pages immediately
        _runSearch('', results);
    }

    function _closeSearchOverlay() {
        var o = document.getElementById('widget-search-overlay');
        if (o) o.remove();
    }

    function _runSearch(query, container) {
        if (!container) return;
        var q = (query || '').toLowerCase();
        var html = '';
        // Pages / apps
        var pages = [
            { name: 'Dashboard', icon: 'dashboard', route: '/' },
            { name: 'Devices', icon: 'devices', route: '/devices' },
            { name: 'Registrations', icon: 'how_to_reg', route: '/registrations' },
            { name: 'Keys', icon: 'vpn_key', route: '/keys' },
            { name: 'Generator', icon: 'build', route: '/generator' },
            { name: 'Users', icon: 'group', route: '/users' },
            { name: 'Audit', icon: 'monitoring', route: '/audit' },
            { name: 'Network', icon: 'wifi', route: '/network' },
            { name: 'CDAP', icon: 'developer_board', route: '/cdap/devices' },
            { name: 'Tokens', icon: 'token', route: '/tokens' },
            { name: 'Settings', icon: 'settings', route: '/settings' }
        ];
        var matchedPages = q ? pages.filter(function (p) { return p.name.toLowerCase().indexOf(q) !== -1; }) : pages;
        if (matchedPages.length) {
            html += '<div class="ws-section">' + esc(t('desktop.search_pages') || 'Pages') + '</div>';
            matchedPages.forEach(function (p) {
                html += '<div class="ws-row" data-route="' + esc(p.route) + '">' +
                    '<span class="material-icons ws-row-icon">' + p.icon + '</span>' +
                    '<span class="ws-row-text">' + esc(p.name) + '</span>' +
                '</div>';
            });
        }
        // Device search (only when there's a query)
        if (q && _deviceSearchCache && _deviceSearchCache.length) {
            var matchDev = _deviceSearchCache.filter(function (d) {
                var src = ((d.id || '') + ' ' + (d.hostname || '') + ' ' + (d.note || '')).toLowerCase();
                return src.indexOf(q) !== -1;
            }).slice(0, 8);
            if (matchDev.length) {
                html += '<div class="ws-section">' + esc(t('desktop.search_devices') || 'Devices') + '</div>';
                matchDev.forEach(function (d) {
                    html += '<div class="ws-row" data-route="/devices" data-device="' + esc(d.id) + '">' +
                        '<span class="material-icons ws-row-icon">computer</span>' +
                        '<span class="ws-row-text">' + esc(d.hostname || d.id) + '</span>' +
                        '<span class="ws-row-hint">' + esc(d.id) + '</span>' +
                    '</div>';
                });
            }
        }
        if (!html) {
            html = '<div class="ws-empty">' + esc(t('desktop.search_no_results') || 'No results') + '</div>';
        }
        container.innerHTML = html;
        // Attach click handlers
        container.querySelectorAll('.ws-row').forEach(function (row) {
            row.addEventListener('click', function () {
                var route = row.dataset.route;
                _closeSearchOverlay();
                if (route && window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                    window.DesktopMode.openAppByRoute(route);
                } else if (route) {
                    window.location.href = route;
                }
            });
        });
    }

    // Cache devices for search (populate on init)
    var _deviceSearchCache = [];
    function _loadDeviceSearchCache() {
        var token = window.BetterDesk && window.BetterDesk.csrfToken;
        fetch('/api/devices', {
            credentials: 'same-origin',
            headers: token ? { 'x-csrf-token': token } : {}
        })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) { _deviceSearchCache = Array.isArray(data) ? data : (data.devices || []); })
        .catch(function () {});
    }

    function renderSidebar() {
        if (document.querySelector('.widget-sidebar')) return;
        var sb = document.createElement('div');
        sb.className = 'widget-sidebar';
        sb.innerHTML =
            '<button class="sidebar-icon active" data-action="home" title="Dashboard"><span class="material-icons">dashboard</span></button>' +
            '<button class="sidebar-icon" data-action="add-widget" title="' + esc(t('desktop.add_widget') || 'Add Widget') + '"><span class="material-icons">add_circle</span></button>' +
            '<button class="sidebar-icon" data-action="wallpaper" title="Wallpaper"><span class="material-icons">wallpaper</span></button>' +
            '<div class="sidebar-sep"></div>' +
            '<button class="sidebar-icon" data-action="edit" title="Edit Layout"><span class="material-icons">edit</span></button>' +
            '<button class="sidebar-icon" data-action="snap-layout" title="' + esc(t('desktop.label_snap_layout') || 'Snap Layout') + '"><span class="material-icons">grid_view</span></button>' +
            '<button class="sidebar-icon" data-action="reset" title="Reset Layout"><span class="material-icons">restart_alt</span></button>' +
            '<div class="sidebar-spacer"></div>' +
            '<button class="sidebar-icon" data-action="help" title="Help"><span class="material-icons">help_outline</span></button>';
        var shell = document.getElementById('desktop-shell');
        if (shell) shell.appendChild(sb);
        sb.querySelectorAll('.sidebar-icon').forEach(function (icon) {
            icon.addEventListener('click', function () {
                var route = icon.dataset.route;
                var action = icon.dataset.action;
                if (action === 'wallpaper') {
                    openWallpaperPicker();
                } else if (action === 'add-widget') {
                    togglePicker();
                } else if (action === 'home') {
                    // Scroll widgets to top/left
                    if (_canvas) _canvas.scrollTo(0, 0);
                } else if (action === 'edit') {
                    document.body.classList.toggle('widget-edit-mode');
                    icon.classList.toggle('active', document.body.classList.contains('widget-edit-mode'));
                } else if (action === 'reset') {
                    if (confirm('Reset widget layout to default?')) {
                        localStorage.removeItem(STORAGE_LAYOUT);
                        localStorage.removeItem(STORAGE_LAYOUT_VER);
                        destroy();
                        init();
                    }
                } else if (action === 'snap-layout') {
                    if (window.DesktopMode && typeof window.DesktopMode.openLayoutOverlay === 'function') {
                        window.DesktopMode.openLayoutOverlay();
                    } else {
                        openWidgetSnapLayoutPicker();
                    }
                } else if (action === 'help') {
                    // Open docs in float window
                    if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                        window.DesktopMode.openAppByRoute('/settings');
                    } else {
                        window.location.href = '/settings';
                    }
                } else if (route) {
                    if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                        window.DesktopMode.openAppByRoute(route);
                    } else {
                        window.location.href = route;
                    }
                }
            });
        });
    }

    function removeSidebar() {
        var sb = document.querySelector('.widget-sidebar');
        if (sb) sb.remove();
    }

    // ============ Default HA-Inspired Layout ============

    function getDefaultLayout() {
        var c = 10, g = 10;
        var c1 = c, c2 = c1 + 310 + g, c3 = c2 + 380 + g, c4 = c3 + 360 + g;
        var r1 = 10, r2 = r1 + 250 + g, r3 = r2 + 210 + g;
        return [
            // Row 1
            { id: uid(), type: 'clock',           x: c1,  y: r1, w: 310, h: 240, z: 1, config: {} },
            { id: uid(), type: 'recent-activity',  x: c2,  y: r1, w: 380, h: 240, z: 2, config: {} },
            { id: uid(), type: 'multi-gauge',      x: c3,  y: r1, w: 360, h: 165, z: 3, config: {} },
            { id: uid(), type: 'uptime',           x: c4,  y: r1, w: 200, h: 165, z: 4, config: {} },
            { id: uid(), type: 'server-health',    x: c4 + 210, y: r1, w: 380, h: 280, z: 5, config: {} },
            // Row 2
            { id: uid(), type: 'weekly-chart',     x: c1,  y: r2, w: 310, h: 200, z: 6, config: {} },
            { id: uid(), type: 'device-grid',      x: c2,  y: r2, w: 380, h: 220, z: 7, config: {} },
            { id: uid(), type: 'bandwidth',        x: c3,  y: r2, w: 360, h: 220, z: 8, config: {} },
            // Row 3
            { id: uid(), type: 'device-status',    x: c1,  y: r3, w: 310, h: 160, z: 10, config: {} },
            { id: uid(), type: 'quick-controls',   x: c2,  y: r3, w: 380, h: 210, z: 11, config: {} },
            { id: uid(), type: 'connection-stats',  x: c3,  y: r3, w: 360, h: 210, z: 12, config: {} },
            { id: uid(), type: 'notes',            x: c4,  y: r3, w: 450, h: 210, z: 13, config: {} }
        ];
    }

    // ============ Widget Presets ============

    var STORAGE_PRESETS = 'bd_widget_presets';
    var BUILTIN_PRESETS = {
        monitoring: {
            name: t('desktop.label_preset_monitoring'),
            widgets: [
                { type: 'server-health', x: 20, y: 20, w: 380, h: 280 },
                { type: 'system-stats', x: 420, y: 20, w: 360, h: 200 },
                { type: 'multi-gauge', x: 800, y: 20, w: 400, h: 180 },
                { type: 'bandwidth', x: 20, y: 320, w: 280, h: 200 },
                { type: 'disk-usage', x: 320, y: 240, w: 320, h: 240 },
                { type: 'process-monitor', x: 660, y: 220, w: 380, h: 300 },
                { type: 'log-viewer', x: 20, y: 540, w: 440, h: 300 },
                { type: 'alert-feed', x: 480, y: 540, w: 340, h: 260 }
            ]
        },
        helpdesk: {
            name: t('desktop.label_preset_helpdesk'),
            widgets: [
                { type: 'device-status', x: 20, y: 20, w: 320, h: 160 },
                { type: 'quick-controls', x: 360, y: 20, w: 400, h: 280 },
                { type: 'tickets-summary', x: 780, y: 20, w: 260, h: 190 },
                { type: 'device-list', x: 20, y: 200, w: 320, h: 300 },
                { type: 'recent-activity', x: 360, y: 320, w: 320, h: 280 },
                { type: 'notes', x: 700, y: 230, w: 260, h: 240 }
            ]
        },
        minimal: {
            name: t('desktop.label_preset_minimal'),
            widgets: [
                { type: 'clock', x: 20, y: 20, w: 240, h: 160 },
                { type: 'device-status', x: 280, y: 20, w: 320, h: 160 },
                { type: 'quick-actions', x: 620, y: 20, w: 260, h: 210 }
            ]
        },
        developer: {
            name: t('desktop.label_preset_developer'),
            widgets: [
                { type: 'log-viewer', x: 20, y: 20, w: 460, h: 320 },
                { type: 'process-monitor', x: 500, y: 20, w: 380, h: 300 },
                { type: 'database-stats', x: 20, y: 360, w: 320, h: 260 },
                { type: 'docker-containers', x: 360, y: 340, w: 380, h: 280 },
                { type: 'shell-command', x: 760, y: 340, w: 400, h: 260 },
                { type: 'speed-test', x: 900, y: 20, w: 280, h: 220 }
            ]
        }
    };

    function _getUserPresets() {
        try { return JSON.parse(localStorage.getItem(STORAGE_PRESETS) || '{}'); }
        catch (e) { return {}; }
    }

    function savePreset(name) {
        if (!name) return;
        var arr = [];
        _widgets.forEach(function (w) {
            arr.push({ type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, config: w.config || {} });
        });
        var presets = _getUserPresets();
        presets[name] = { name: name, widgets: arr, wallpaper: _wallpaperPath };
        localStorage.setItem(STORAGE_PRESETS, JSON.stringify(presets));
    }

    function loadPreset(key) {
        var preset = BUILTIN_PRESETS[key] || (_getUserPresets()[key]);
        if (!preset || !preset.widgets) return;
        // Clear current widgets
        _widgets.forEach(function (w) { destroyWidget(w.id, true); });
        _widgets.clear();
        _zCounter = 1;
        // Add preset widgets
        preset.widgets.forEach(function (pw) {
            var id = uid();
            _widgets.set(id, {
                id: id, type: pw.type, x: pw.x || 20, y: pw.y || 20,
                w: pw.w || 240, h: pw.h || 200, z: ++_zCounter, config: pw.config || {}
            });
        });
        if (preset.wallpaper) applyWallpaper(preset.wallpaper, 'cover', true);
        saveLayout();
        renderAll();
    }

    function deletePreset(key) {
        var presets = _getUserPresets();
        delete presets[key];
        localStorage.setItem(STORAGE_PRESETS, JSON.stringify(presets));
    }

    function listPresets() {
        var result = [];
        Object.keys(BUILTIN_PRESETS).forEach(function (k) {
            result.push({ key: k, name: BUILTIN_PRESETS[k].name, builtin: true });
        });
        var user = _getUserPresets();
        Object.keys(user).forEach(function (k) {
            result.push({ key: k, name: user[k].name || k, builtin: false });
        });
        return result;
    }

    // ============ Phase 42: Snap Layout Zones ============

    var SNAP_LAYOUTS = [
        { key: '2col',   name: t('desktop.label_2col_equal'), zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
        { key: '2col64', name: t('desktop.label_2col_wide'),  zones: [{ x: 0, y: 0, w: 0.6, h: 1 }, { x: 0.6, y: 0, w: 0.4, h: 1 }] },
        { key: '3col',   name: t('desktop.label_3col'),       zones: [{ x: 0, y: 0, w: 0.33, h: 1 }, { x: 0.33, y: 0, w: 0.34, h: 1 }, { x: 0.67, y: 0, w: 0.33, h: 1 }] },
        { key: '2x2',    name: t('desktop.label_2x2_grid'),   zones: [{ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] },
        { key: '1_2',    name: t('desktop.label_1_2'),        zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] },
        { key: '1_3',    name: t('desktop.label_1_3'),        zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.33 }, { x: 0.5, y: 0.33, w: 0.5, h: 0.34 }, { x: 0.5, y: 0.67, w: 0.5, h: 0.33 }] }
    ];

    var _widgetSnapOverlay = null;

    /** Show the snap layout picker overlay */
    function openWidgetSnapLayoutPicker() {
        if (_widgetSnapOverlay) { closeWidgetSnapLayoutPicker(); return; }
        _widgetSnapOverlay = document.createElement('div');
        _widgetSnapOverlay.className = 'widget-snap-layout-overlay';
        var html = '<div class="widget-snap-layout-picker">' +
            '<div class="widget-snap-layout-title">' + esc(t('desktop.label_snap_layout')) + '</div>' +
            '<div class="widget-snap-layout-options">';
        SNAP_LAYOUTS.forEach(function (layout) {
            html += '<div class="widget-snap-layout-option" data-key="' + layout.key + '" title="' + esc(layout.name) + '">';
            html += '<div class="widget-snap-layout-preview">';
            layout.zones.forEach(function (z) {
                html += '<div class="widget-snap-zone-preview" style="left:' + (z.x * 100) + '%;top:' + (z.y * 100) + '%;width:' + (z.w * 100) + '%;height:' + (z.h * 100) + '%"></div>';
            });
            html += '</div><div class="widget-snap-layout-label">' + esc(layout.name) + '</div></div>';
        });
        html += '</div>' +
            '<button class="widget-snap-auto-arrange-btn"><span class="material-icons">auto_fix_high</span>' + esc(t('desktop.label_auto_arrange')) + '</button>' +
            '</div>';
        _widgetSnapOverlay.innerHTML = html;

        // Click layout option
        _widgetSnapOverlay.querySelectorAll('.widget-snap-layout-option').forEach(function (opt) {
            opt.addEventListener('click', function (e) {
                e.stopPropagation();
                applySnapLayout(opt.dataset.key);
                closeWidgetSnapLayoutPicker();
            });
        });

        // Auto-arrange
        var autoBtn = _widgetSnapOverlay.querySelector('.widget-snap-auto-arrange-btn');
        if (autoBtn) {
            autoBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                autoArrangeWidgets();
                closeWidgetSnapLayoutPicker();
            });
        }

        // Click outside to close
        _widgetSnapOverlay.addEventListener('click', function (e) {
            if (e.target === _widgetSnapOverlay) closeWidgetSnapLayoutPicker();
        });

        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(_widgetSnapOverlay);
    }

    function closeWidgetSnapLayoutPicker() {
        if (_widgetSnapOverlay && _widgetSnapOverlay.parentNode) {
            _widgetSnapOverlay.parentNode.removeChild(_widgetSnapOverlay);
        }
        _widgetSnapOverlay = null;
    }

    /** Apply a snap layout — distribute existing widgets across zones */
    function applySnapLayout(key) {
        var layout = SNAP_LAYOUTS.find(function (l) { return l.key === key; });
        if (!layout) return;

        var area = getCanvasArea();
        var PAD = 10;
        var widgetArr = [];
        _widgets.forEach(function (w) { widgetArr.push(w); });
        if (!widgetArr.length) return;

        // Assign widgets to zones round-robin
        widgetArr.forEach(function (w, idx) {
            var zone = layout.zones[idx % layout.zones.length];
            w.x = snap(zone.x * area.w + PAD);
            w.y = snap(zone.y * area.h + PAD);
            w.w = snap(zone.w * area.w - PAD * 2);
            w.h = snap(zone.h * area.h - PAD * 2);
            w.w = Math.max(MIN_W, w.w);
            w.h = Math.max(MIN_H, w.h);

            var el = document.getElementById(w.id);
            if (el) {
                el.style.left = w.x + 'px';
                el.style.top = w.y + 'px';
                el.style.width = w.w + 'px';
                el.style.height = w.h + 'px';
            }
        });
        saveLayout();
    }

    /** Auto-arrange: tile widgets in a grid layout filling available space */
    function autoArrangeWidgets() {
        var area = getCanvasArea();
        var count = _widgets.size;
        if (!count) return;

        // Determine grid columns (√n rounded up)
        var cols = Math.ceil(Math.sqrt(count));
        var rows = Math.ceil(count / cols);
        var PAD = 10;
        var cellW = Math.floor(area.w / cols);
        var cellH = Math.floor(area.h / rows);

        var idx = 0;
        _widgets.forEach(function (w) {
            var col = idx % cols;
            var row = Math.floor(idx / cols);
            w.x = snap(col * cellW + PAD);
            w.y = snap(row * cellH + PAD);
            w.w = snap(cellW - PAD * 2);
            w.h = snap(cellH - PAD * 2);
            w.w = Math.max(MIN_W, w.w);
            w.h = Math.max(MIN_H, w.h);

            var el = document.getElementById(w.id);
            if (el) {
                el.style.left = w.x + 'px';
                el.style.top = w.y + 'px';
                el.style.width = w.w + 'px';
                el.style.height = w.h + 'px';
            }
            idx++;
        });
        saveLayout();
    }

    // ============ Widget Groups (Tabbed Containers) ============

    var _groups = new Map(); // groupId → { id, label, tabs: [widgetId, ...], activeTab: 0 }
    var STORAGE_GROUPS = 'bd_widget_groups';

    function loadGroups() {
        try {
            var raw = localStorage.getItem(STORAGE_GROUPS);
            if (!raw) return;
            var arr = JSON.parse(raw);
            if (Array.isArray(arr)) arr.forEach(function (g) { _groups.set(g.id, g); });
        } catch (_) { /* ignore */ }
    }

    function saveGroups() {
        var arr = [];
        _groups.forEach(function (g) { arr.push(g); });
        localStorage.setItem(STORAGE_GROUPS, JSON.stringify(arr));
    }

    function createGroup(widgetIds, label) {
        if (!widgetIds || widgetIds.length < 2) return null;
        var groupId = 'group-' + uid();
        var group = {
            id: groupId,
            label: label || t('desktop.widget_group'),
            tabs: widgetIds.slice(),
            activeTab: 0
        };
        _groups.set(groupId, group);

        // Use the first widget's position for the group
        var first = _widgets.get(widgetIds[0]);
        if (!first) return null;

        // Hide all widgets except the active one
        widgetIds.forEach(function (wid, idx) {
            var w = _widgets.get(wid);
            if (w) {
                w._groupId = groupId;
                w._groupIdx = idx;
                var el = document.getElementById(wid);
                if (el) el.style.display = (idx === 0) ? '' : 'none';
            }
        });

        // Add tab bar to the active widget's DOM
        _renderGroupTabs(groupId);
        saveGroups();
        saveLayout();
        return groupId;
    }

    function _renderGroupTabs(groupId) {
        var group = _groups.get(groupId);
        if (!group) return;

        // Attach tab bar to the first visible widget
        var activeWid = group.tabs[group.activeTab];
        var el = document.getElementById(activeWid);
        if (!el) return;

        // Remove existing tab bar if any
        var existing = el.querySelector('.widget-group-tabs');
        if (existing) existing.remove();

        var tabBar = document.createElement('div');
        tabBar.className = 'widget-group-tabs';

        group.tabs.forEach(function (wid, idx) {
            var w = _widgets.get(wid);
            var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w ? w.type : '');
            var label = (plugin && plugin.label) || (w ? w.type : 'Tab');

            var tab = document.createElement('button');
            tab.className = 'widget-group-tab' + (idx === group.activeTab ? ' active' : '');
            tab.textContent = label;
            tab.addEventListener('click', function (e) {
                e.stopPropagation();
                switchGroupTab(groupId, idx);
            });
            tabBar.appendChild(tab);
        });

        // Ungroup button
        var ungroupBtn = document.createElement('button');
        ungroupBtn.className = 'widget-group-ungroup';
        ungroupBtn.innerHTML = '<span class="material-icons" style="font-size:14px">tab_unselected</span>';
        ungroupBtn.title = t('desktop.ungroup_widgets');
        ungroupBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            ungroupWidgets(groupId);
        });
        tabBar.appendChild(ungroupBtn);

        // Insert after header
        var header = el.querySelector('.widget-header');
        if (header) header.after(tabBar);
        else el.prepend(tabBar);
    }

    function switchGroupTab(groupId, tabIdx) {
        var group = _groups.get(groupId);
        if (!group || tabIdx < 0 || tabIdx >= group.tabs.length) return;

        var prevWid = group.tabs[group.activeTab];
        var nextWid = group.tabs[tabIdx];
        group.activeTab = tabIdx;

        // Hide previous, show next
        var prevEl = document.getElementById(prevWid);
        var nextEl = document.getElementById(nextWid);

        if (prevEl) {
            // Copy position to next widget
            var prevW = _widgets.get(prevWid);
            var nextW = _widgets.get(nextWid);
            if (prevW && nextW) {
                nextW.x = prevW.x;
                nextW.y = prevW.y;
                nextW.w = prevW.w;
                nextW.h = prevW.h;
                nextW.z = prevW.z;
            }
            prevEl.style.display = 'none';
        }

        if (nextEl) {
            var nw = _widgets.get(nextWid);
            if (nw) {
                nextEl.style.left = nw.x + 'px';
                nextEl.style.top = nw.y + 'px';
                nextEl.style.width = nw.w + 'px';
                nextEl.style.height = nw.h + 'px';
            }
            nextEl.style.display = '';
        }

        _renderGroupTabs(groupId);
        saveGroups();
    }

    function ungroupWidgets(groupId) {
        var group = _groups.get(groupId);
        if (!group) return;

        var baseX = 0, baseY = 0;
        var first = _widgets.get(group.tabs[0]);
        if (first) { baseX = first.x; baseY = first.y; }

        group.tabs.forEach(function (wid, idx) {
            var w = _widgets.get(wid);
            if (w) {
                delete w._groupId;
                delete w._groupIdx;
                w.x = baseX + idx * 30;
                w.y = baseY + idx * 30;
            }
            var el = document.getElementById(wid);
            if (el) {
                el.style.display = '';
                if (w) {
                    el.style.left = w.x + 'px';
                    el.style.top = w.y + 'px';
                }
                var tabBar = el.querySelector('.widget-group-tabs');
                if (tabBar) tabBar.remove();
            }
        });

        _groups.delete(groupId);
        saveGroups();
        saveLayout();
    }

    // ============ Responsive Auto-Reposition ============

    var _prevCanvasArea = null;

    function autoReposition() {
        if (!layoutPersistenceEnabled()) return;
        var area = getCanvasArea();
        if (area.w < 200 || area.h < 200) return;

        // Proportional scaling when canvas size changes significantly
        var scaleX = 1, scaleY = 1;
        if (_prevCanvasArea && _prevCanvasArea.w > 0 && _prevCanvasArea.h > 0) {
            scaleX = area.w / _prevCanvasArea.w;
            scaleY = area.h / _prevCanvasArea.h;
        }
        var useScale = _prevCanvasArea && (Math.abs(scaleX - 1) > 0.05 || Math.abs(scaleY - 1) > 0.05);

        _widgets.forEach(function (w) {
            var el = document.getElementById(w.id);
            if (!el) return;
            var changed = false;

            // Scale positions proportionally on significant resize
            if (useScale) {
                w.x = snap(w.x * scaleX);
                w.y = snap(w.y * scaleY);
                changed = true;
            }

            // Shrink if widget is larger than canvas
            if (w.w > area.w - 20) { w.w = Math.max(MIN_W, area.w - 20); changed = true; }
            if (w.h > area.h - 20) { w.h = Math.max(MIN_H, area.h - 20); changed = true; }

            // Clamp to canvas bounds
            var maxX = Math.max(0, area.w - w.w);
            var maxY = Math.max(0, area.h - w.h);
            if (w.x < 0) { w.x = 0; changed = true; }
            if (w.y < 0) { w.y = 0; changed = true; }
            if (w.x > maxX) { w.x = maxX; changed = true; }
            if (w.y > maxY) { w.y = maxY; changed = true; }

            if (changed) {
                el.style.left = w.x + 'px';
                el.style.top  = w.y + 'px';
                el.style.width  = w.w + 'px';
                el.style.height = w.h + 'px';
            }
        });

        _prevCanvasArea = { w: area.w, h: area.h };
        saveLayout();
    }

    // Watch for window resize and auto-reposition
    var _repositionTimeout = null;
    window.addEventListener('resize', function () {
        if (!layoutPersistenceEnabled()) return;
        clearTimeout(_repositionTimeout);
        _repositionTimeout = setTimeout(autoReposition, 300);
    });

    // ============ Pop-Out Floating Windows ============

    /**
     * Pop out a widget into an independent browser popup window.
     * The popup communicates with the parent via postMessage for state updates.
     */
    function popOutWidget(widgetId) {
        var w = _widgets.get(widgetId);
        if (!w) return;
        // Already popped out — focus existing popup
        var existing = _popouts.get(widgetId);
        if (existing && existing.win && !existing.win.closed) {
            existing.win.focus();
            return;
        }

        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        if (!plugin) return;

        var popW = Math.max(w.w + 32, 280);
        var popH = Math.max(w.h + 60, 220);
        var left = (window.screenX || window.screenLeft) + 80;
        var top  = (window.screenY || window.screenTop) + 80;

        var popup = window.open('', '_blank',
            'width=' + popW + ',height=' + popH +
            ',left=' + left + ',top=' + top +
            ',resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no'
        );
        if (!popup) return; // Blocked by browser

        var iconColor = plugin.color || '#58a6ff';
        var title = esc(plugin.name || w.type);
        var theme = document.documentElement.getAttribute('data-desktop-theme') || 'dark';

        // Build self-contained popup HTML
        popup.document.open();
        popup.document.write(
            '<!DOCTYPE html><html lang="en" data-desktop-theme="' + esc(theme) + '">' +
            '<head><meta charset="utf-8"><title>' + title + ' — BetterDesk Widget</title>' +
            '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">' +
            '<style>' + _getPopoutCSS() + '</style></head>' +
            '<body>' +
            '<div class="popout-header">' +
                '<span class="material-icons popout-icon" style="color:' + esc(iconColor) + '">' + esc(plugin.icon || 'widgets') + '</span>' +
                '<span class="popout-title">' + title + '</span>' +
                '<button class="popout-pop-in" title="' + esc(t('desktop.pop_in_widget')) + '">' +
                    '<span class="material-icons">pip_exit</span>' +
                '</button>' +
            '</div>' +
            '<div id="widget-body" class="popout-body"></div>' +
            '<script>' +
                'var _widgetId = ' + JSON.stringify(widgetId) + ';' +
                'document.querySelector(".popout-pop-in").addEventListener("click", function () {' +
                    'window.opener && window.opener.postMessage({type:"widget-popin",widgetId:_widgetId},"*");' +
                    'window.close();' +
                '});' +
                'window.addEventListener("beforeunload", function () {' +
                    'window.opener && window.opener.postMessage({type:"widget-popin",widgetId:_widgetId},"*");' +
                '});' +
            '<\/script>' +
            '</body></html>'
        );
        popup.document.close();

        // Hide widget on main canvas
        var el = document.getElementById(widgetId);
        if (el) el.style.display = 'none';

        // Render plugin content into popup body
        var popupBody = popup.document.getElementById('widget-body');
        if (plugin.render && popupBody) {
            try { plugin.render(popupBody, w.config, w); } catch (err) {
                popupBody.innerHTML = '<div style="padding:16px;color:#f85149;">Render error</div>';
            }
        }

        // Start update cycle in popup
        var updateTimer = null;
        if (plugin.update) {
            var interval = plugin.updateInterval || UPDATE_INTERVAL;
            var doUpdate = function () {
                if (popup.closed) { _cleanupPopout(widgetId); return; }
                var body = popup.document.getElementById('widget-body');
                if (body) {
                    try { plugin.update(body, w.config, w); } catch (_) {}
                }
            };
            doUpdate();
            updateTimer = setInterval(doUpdate, interval);
        }

        // Track popup with close-detection interval
        var closeCheck = setInterval(function () {
            if (!popup || popup.closed) {
                _cleanupPopout(widgetId);
            }
        }, 1000);

        // Stop main canvas timer for this widget (popup owns updates now)
        stopWidgetTimer(widgetId);

        _popouts.set(widgetId, { win: popup, timer: updateTimer, closeCheck: closeCheck });
    }

    /**
     * Restore a popped-out widget back to the main canvas.
     */
    function popInWidget(widgetId) {
        _cleanupPopout(widgetId);
        var el = document.getElementById(widgetId);
        if (el) {
            el.style.display = '';
            // Restart data updates on main canvas
            var w = _widgets.get(widgetId);
            if (w) startWidgetTimer(w);
        }
    }

    function _cleanupPopout(widgetId) {
        var p = _popouts.get(widgetId);
        if (!p) return;
        if (p.timer) clearInterval(p.timer);
        if (p.closeCheck) clearInterval(p.closeCheck);
        if (p.win && !p.win.closed) p.win.close();
        _popouts.delete(widgetId);

        // Restore widget visibility on main canvas
        var el = document.getElementById(widgetId);
        if (el) el.style.display = '';

        // Restart main canvas update timer
        var w = _widgets.get(widgetId);
        if (w) startWidgetTimer(w);
    }

    /** Listen for pop-in messages from popup windows */
    window.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== 'widget-popin') return;
        var widgetId = e.data.widgetId;
        if (widgetId && _popouts.has(widgetId)) popInWidget(widgetId);
    });

    /** Minimal CSS for the popup window */
    function _getPopoutCSS() {
        var isDark = (document.documentElement.getAttribute('data-desktop-theme') || 'dark') !== 'light';
        var bg = isDark ? '#0d1117' : '#ffffff';
        var fg = isDark ? '#e6edf3' : '#1f2328';
        var border = isDark ? '#30363d' : '#d1d9e0';
        var headerBg = isDark ? 'rgba(22,27,34,0.92)' : 'rgba(245,248,255,0.92)';
        var accent = '#58a6ff';

        return '' +
            '*, *::before, *::after { box-sizing: border-box; }' +
            'body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; ' +
                'background: ' + bg + '; color: ' + fg + '; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }' +
            '.popout-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; ' +
                'background: ' + headerBg + '; border-bottom: 1px solid ' + border + '; ' +
                '-webkit-app-region: drag; user-select: none; flex-shrink: 0; }' +
            '.popout-icon { font-size: 18px; }' +
            '.popout-title { font-size: 13px; font-weight: 600; flex: 1; }' +
            '.popout-pop-in { background: none; border: none; cursor: pointer; color: ' + fg + '; ' +
                'padding: 4px; border-radius: 4px; -webkit-app-region: no-drag; display: flex; align-items: center; }' +
            '.popout-pop-in:hover { background: ' + (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') + '; }' +
            '.popout-body { flex: 1; overflow: auto; padding: 8px; }' +
            /* Widget body styling resets for popup context */
            '.widget-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; ' +
                'gap: 8px; height: 100%; color: ' + (isDark ? '#8b949e' : '#656d76') + '; font-size: 13px; }' +
            '.widget-empty .material-icons { font-size: 32px; opacity: 0.5; }' +
            /* Common widget content styles */
            'table { width: 100%; border-collapse: collapse; font-size: 12px; }' +
            'th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid ' + border + '; }' +
            'th { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ' + (isDark ? '#8b949e' : '#656d76') + '; }' +
            '.gauge-bar { height: 6px; border-radius: 3px; background: ' + (isDark ? '#21262d' : '#eaeef2') + '; overflow: hidden; }' +
            '.gauge-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }' +
            '.stat-value { font-size: 20px; font-weight: 700; }' +
            '.stat-label { font-size: 11px; color: ' + (isDark ? '#8b949e' : '#656d76') + '; }' +
            /* Link and button styling */
            'a { color: ' + accent + '; text-decoration: none; }' +
            'button:not(.popout-pop-in) { font-family: inherit; }' +
            '.material-icons { font-family: "Material Icons"; font-size: 18px; }';
    }

    // ============ Public API ============

    window.DesktopWidgets = {
        init: init,
        destroy: destroy,
        addWidget: addWidget,
        removeWidget: removeWidget,
        setWallpaper: setWallpaper,
        openWallpaperPicker: openWallpaperPicker,
        openPicker: openPicker,
        getWidgets: function () { return _widgets; },
        removeAddButton: removeAddButton,
        renderAddButton: renderAddButton,
        refreshAll: refreshAll,
        toggleGrid: toggleGridOverlay,
        isGridVisible: function () { return _showGrid; },
        savePreset: savePreset,
        loadPreset: loadPreset,
        deletePreset: deletePreset,
        listPresets: listPresets,
        openSnapLayout: openWidgetSnapLayoutPicker,
        autoArrange: autoArrangeWidgets,
        applySnapLayout: applySnapLayout,
        // Widget groups (Phase 11)
        createGroup: createGroup,
        ungroupWidgets: ungroupWidgets,
        switchGroupTab: switchGroupTab,
        getGroups: function () { return _groups; },
        // Floating popup windows (Phase 42)
        popOutWidget: popOutWidget,
        popInWidget: popInWidget,
        autoReposition: autoReposition
    };

})();
