/**
 * BetterDesk Console — Widget Plugin System
 * Registry + 12 built-in widget types for the desktop dashboard.
 * Depends: desktop-widgets.js, Utils, _ (i18n)
 */

(function () {
    'use strict';

    var _registry = new Map();
    var t = function (k) { return typeof _ === 'function' ? _(k) : k; };

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function escAttr(s) {
        return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ============ Registry API ============

    function register(type, config) {
        if (!type || !config) return;
        config.type = type;
        _registry.set(type, config);
    }

    function get(type) { return _registry.get(type); }

    function list() {
        var arr = [];
        _registry.forEach(function (v) { arr.push(v); });
        return arr;
    }

    // ============ Helpers ============

    function apiGet(url) {
        if (typeof Utils !== 'undefined' && Utils.api) {
            return Utils.api(url).then(function (res) {
                if (res && typeof res.json === 'function') return res.json();
                return res;
            });
        }
        return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }

    function buildGaugeSVG(pct, size) {
        size = size || 100;
        var r = (size - 8) / 2;
        var circ = 2 * Math.PI * r;
        var off = circ * (1 - pct / 100);
        var cls = pct > 85 ? 'danger' : (pct > 65 ? 'warning' : '');
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
            '<circle class="gauge-bg" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '"/>' +
            '<circle class="gauge-fill ' + cls + '" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" ' +
                'stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '"/>' +
        '</svg>';
    }

    function timeSince(date) {
        var seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
        return Math.floor(seconds / 86400) + 'd';
    }

    function connectedSeconds(peer) {
        if (peer && peer.online_since) {
            var startedAt = new Date(peer.online_since).getTime();
            if (Number.isFinite(startedAt)) {
                return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            }
        }
        var reported = Number(peer && peer.online_seconds);
        return Number.isFinite(reported) && reported >= 0 ? Math.floor(reported) : null;
    }

    function formatConnectedDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '';
        var totalMinutes = Math.floor(seconds / 60);
        var days = Math.floor(totalMinutes / 1440);
        var hours = Math.floor((totalMinutes % 1440) / 60);
        var minutes = totalMinutes % 60;
        if (days > 0) return days + 'd ' + String(hours).padStart(2, '0') + 'h ' + String(minutes).padStart(2, '0') + 'm';
        if (hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
        return minutes + 'm';
    }

    // ============ Built-in Widgets ============

    // 1. Clock
    register('clock', {
        name: t('desktop.widget_clock'),
        icon: 'schedule',
        color: '#58a6ff',
        category: 'general',
        description: 'Digital clock with date',
        defaultSize: { w: 240, h: 160 },
        minSize: { w: 180, h: 120 },
        _interval: null,
        render: function (body) {
            body.innerHTML = '<div class="widget-clock-time"></div><div class="widget-clock-date"></div>';
            this._tick(body);
            var self = this;
            body._clockInterval = setInterval(function () { self._tick(body); }, 1000);
        },
        _tick: function (body) {
            var now = new Date();
            var timeEl = body.querySelector('.widget-clock-time');
            var dateEl = body.querySelector('.widget-clock-date');
            if (timeEl) {
                var h = String(now.getHours()).padStart(2, '0');
                var m = String(now.getMinutes()).padStart(2, '0');
                var s = String(now.getSeconds()).padStart(2, '0');
                timeEl.innerHTML = h + ':' + m + '<span class="widget-clock-seconds">:' + s + '</span>';
            }
            if (dateEl) {
                dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            }
        },
        destroy: function (body) {
            if (body && body._clockInterval) {
                clearInterval(body._clockInterval);
                body._clockInterval = null;
            }
        }
    });

    // 2. Device Status (counters)
    register('device-status', {
        name: t('desktop.widget_device_status'),
        icon: 'devices',
        color: '#3fb950',
        category: 'monitoring',
        description: 'Online / offline / total device counters',
        defaultSize: { w: 320, h: 160 },
        minSize: { w: 240, h: 130 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-status-counters">' +
                '<div class="widget-status-counter online"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_online') + '</div></div>' +
                '<div class="widget-status-counter offline"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_offline') + '</div></div>' +
                '<div class="widget-status-counter total"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_total') + '</div></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var online = body.querySelector('.online .widget-status-counter-value');
                var offline = body.querySelector('.offline .widget-status-counter-value');
                var total = body.querySelector('.total .widget-status-counter-value');
                if (online) online.textContent = d.online || 0;
                if (offline) offline.textContent = d.offline || 0;
                if (total) total.textContent = d.total || 0;
            }).catch(function () {});
        }
    });

    // 3. Server Info (combined health + ports + uptime)
    register('server-health', {
        name: t('desktop.widget_server_health'),
        icon: 'dns',
        color: '#f0883e',
        category: 'monitoring',
        description: 'Services, ports, and uptime overview',
        defaultSize: { w: 380, h: 280 },
        minSize: { w: 300, h: 220 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-server-info">' +
                '<div class="widget-si-services">' +
                    '<div class="widget-si-svc" data-svc="signal"><div class="widget-si-dot unknown"></div><span>Signal</span></div>' +
                    '<div class="widget-si-svc" data-svc="relay"><div class="widget-si-dot unknown"></div><span>Relay</span></div>' +
                    '<div class="widget-si-svc" data-svc="console"><div class="widget-si-dot up"></div><span>Console</span></div>' +
                '</div>' +
                '<div class="widget-si-uptime" data-si="uptime">' + t('desktop.label_uptime') + ': -</div>' +
                '<div class="widget-si-ports">' +
                    '<div class="widget-si-port-header"><span>' + t('desktop.label_service') + '</span><span>' + t('desktop.label_port') + '</span></div>' +
                '</div></div>';
        },
        update: function (body) {
            apiGet('/api/server/status').then(function (data) {
                if (!data) return;
                // Services
                var sig = (data.signal || data.hbbs || {}).status || 'unknown';
                var rel = (data.hbbr || {}).status || 'unknown';
                var sigEl = body.querySelector('[data-svc="signal"]');
                var relEl = body.querySelector('[data-svc="relay"]');
                if (sigEl) { var d = sigEl.querySelector('.widget-si-dot'); if (d) d.className = 'widget-si-dot ' + (sig === 'running' ? 'up' : 'down'); }
                if (relEl) { var d = relEl.querySelector('.widget-si-dot'); if (d) d.className = 'widget-si-dot ' + (rel === 'running' ? 'up' : 'down'); }
                // Uptime
                var ut = body.querySelector('[data-si="uptime"]');
                if (ut && data.uptime != null) {
                    var s = data.uptime;
                    var days = Math.floor(s / 86400); s %= 86400;
                    var hrs = Math.floor(s / 3600); s %= 3600;
                    var mins = Math.floor(s / 60);
                    var parts = [];
                    if (days) parts.push(days + 'd');
                    if (hrs) parts.push(hrs + 'h');
                    parts.push(mins + 'm');
                    ut.textContent = t('desktop.label_uptime') + ': ' + parts.join(' ');
                }
                // Ports
                var pc = body.querySelector('.widget-si-ports');
                if (!pc) return;
                var rows = [
                    { name: 'Signal', port: data.signal_port || 21116, up: sig === 'running' },
                    { name: 'Relay', port: data.relay_port || 21117, up: rel === 'running' },
                    { name: 'WS Signal', port: data.ws_signal_port || 21118, up: sig === 'running' },
                    { name: 'WS Relay', port: data.ws_relay_port || 21119, up: rel === 'running' },
                    { name: 'API', port: data.api_port || 21121, up: true },
                    { name: 'Client API', port: data.client_api_port || 21121, up: true },
                    { name: 'Console', port: data.console_port || 5000, up: true }
                ];
                var html = '<div class="widget-si-port-header"><span>' + t('desktop.label_service') + '</span><span>' + t('desktop.label_port') + '</span></div>';
                rows.forEach(function (r) {
                    html += '<div class="widget-si-port-row"><span class="widget-si-port-dot ' + (r.up ? 'up' : 'down') + '"></span><span class="widget-si-port-name">' + esc(r.name) + '</span><span class="widget-si-port-num">' + r.port + '</span></div>';
                });
                pc.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 4. Device Stats Gauges
    register('system-stats', {
        name: t('desktop.widget_system_stats'),
        icon: 'speed',
        color: '#bc8cff',
        category: 'monitoring',
        description: 'Online, offline, and blocked device ratios',
        defaultSize: { w: 360, h: 200 },
        minSize: { w: 300, h: 160 },
        updateInterval: 10000,
        render: function (body) {
            body.innerHTML = '<div style="display:flex;gap:16px;justify-content:center;align-items:center;height:100%;">' +
                '<div class="widget-gauge" id="gauge-cpu"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_online') + '</div></div>' +
                '<div class="widget-gauge" id="gauge-mem"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_offline') + '</div></div>' +
                '<div class="widget-gauge" id="gauge-disk"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_blocked') + '</div></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var total = d.total || 1;
                var onlinePct = Math.round(((d.online || 0) / total) * 100);
                var offlinePct = Math.round(((d.offline || 0) / total) * 100);
                var blockedPct = Math.round(((d.banned || d.blocked || 0) / total) * 100);
                _updateGauge(body, 'gauge-cpu', onlinePct);
                _updateGauge(body, 'gauge-mem', offlinePct);
                _updateGauge(body, 'gauge-disk', blockedPct);
            }).catch(function () {});
        }
    });

    function _updateGauge(body, id, pct) {
        var gauge = body.querySelector('#' + id);
        if (!gauge) return;
        var ring = gauge.querySelector('.widget-gauge-ring');
        var val  = gauge.querySelector('.widget-gauge-value');
        if (ring) {
            // Replace SVG
            var svg = ring.querySelector('svg');
            var newRing = document.createElement('div');
            newRing.innerHTML = buildGaugeSVG(pct);
            if (svg) ring.replaceChild(newRing.firstChild, svg);
        }
        if (val) val.textContent = Math.round(pct) + '%';
    }

    // 5. Device List (mini table)
    register('device-list', {
        name: t('desktop.widget_device_list'),
        icon: 'list',
        color: '#79c0ff',
        category: 'devices',
        description: 'Scrollable list of all devices',
        defaultSize: { w: 360, h: 300 },
        minSize: { w: 280, h: 200 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = [];
                if (data && data.devices) peers = data.devices;
                else if (Array.isArray(data)) peers = data;

                var list = body.querySelector('.widget-device-list');
                if (!list) return;
                if (!peers.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }

                var html = '';
                peers.slice().sort(function (a, b) {
                    var aOnline = !!(a.live_online || a.online);
                    var bOnline = !!(b.live_online || b.online);
                    if (aOnline !== bOnline) return aOnline ? -1 : 1;
                    var aName = a.display_name || a.hostname || a.name || a.id || '';
                    var bName = b.display_name || b.hostname || b.name || b.id || '';
                    return aName.localeCompare(bName);
                }).slice(0, 50).forEach(function (p) {
                    var online = p.live_online || p.online || false;
                    var status = online ? 'online' : 'offline';
                    var deviceId = String(p.id || '-');
                    var deviceName = String(p.display_name || p.hostname || p.name || deviceId);
                    var platform = String(p.platform || p.os || '');
                    var seconds = online ? connectedSeconds(p) : null;
                    var duration = online ? formatConnectedDuration(seconds) : '';
                    var statusLabel = online ? t('devices.connected') : t('devices.disconnected');
                    var durationTitle = duration ? t('devices.connected_for') + ' ' + duration : statusLabel;
                    html += '<div class="widget-device-row">' +
                        '<div class="widget-device-dot ' + status + '"></div>' +
                        '<div class="widget-device-identity">' +
                            '<div class="widget-device-name" title="' + escAttr(deviceName) + '">' + esc(deviceName) + '</div>' +
                            '<div class="widget-device-meta">' +
                                '<span class="widget-device-id">' + esc(deviceId) + '</span>' +
                                '<span class="widget-device-platform">' + esc(platform) + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="widget-device-connection ' + status + '" title="' + escAttr(durationTitle) + '">' +
                            '<span class="widget-device-connection-status">' + esc(statusLabel) + '</span>' +
                            (duration ? '<span class="widget-device-duration">' + esc(duration) + '</span>' : '') +
                        '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 6. Quick Actions
    register('quick-actions', {
        name: t('desktop.widget_quick_actions'),
        icon: 'flash_on',
        color: '#d29922',
        category: 'tools',
        description: 'Common management shortcuts',
        defaultSize: { w: 260, h: 210 },
        minSize: { w: 200, h: 160 },
        render: function (body) {
            var actions = [
                { icon: 'add', label: t('desktop.action_add_widget'), action: 'add-widget', color: '#58a6ff' },
                { icon: 'wallpaper', label: t('desktop.wallpaper'), action: 'wallpaper', color: '#bc8cff' },
                { icon: 'devices', label: t('nav.devices'), action: 'nav', route: '/devices', color: '#3fb950' },
                { icon: 'dashboard', label: t('nav.dashboard'), action: 'nav', route: '/', color: '#f0883e' },
                { icon: 'vpn_key', label: t('nav.keys'), action: 'nav', route: '/keys', color: '#d29922' },
                { icon: 'settings', label: t('nav.settings'), action: 'nav', route: '/settings', color: '#8b949e' }
            ];

            var html = '<div class="widget-actions-grid">';
            actions.forEach(function (a) {
                html += '<div class="widget-action-btn" data-action="' + esc(a.action) + '" data-route="' + esc(a.route || '') + '">' +
                    '<span class="material-icons" style="color:' + esc(a.color) + '">' + esc(a.icon) + '</span>' +
                    '<span>' + esc(a.label) + '</span>' +
                '</div>';
            });
            html += '</div>';
            body.innerHTML = html;

            body.querySelectorAll('.widget-action-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var action = btn.dataset.action;
                    if (action === 'nav' && btn.dataset.route) {
                        window.location.href = btn.dataset.route;
                    } else if (action === 'wallpaper' && window.DesktopWidgets) {
                        window.DesktopWidgets.openWallpaperPicker();
                    } else if (action === 'add-widget' && window.DesktopWidgets) {
                        window.DesktopWidgets.openPicker();
                    }
                });
            });
        }
    });

    // 7. Recent Activity (feed)
    register('recent-activity', {
        name: t('desktop.widget_recent_activity'),
        icon: 'history',
        color: '#f778ba',
        category: 'monitoring',
        description: 'Latest audit events',
        defaultSize: { w: 320, h: 280 },
        minSize: { w: 240, h: 180 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-feed-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/audit/conn?limit=20').then(function (data) {
                var events = data;
                if (data && data.data) events = data.data;
                if (!Array.isArray(events)) return;

                var list = body.querySelector('.widget-feed-list');
                if (!list) return;
                if (!events.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">history</span><span>' + t('desktop.label_no_activity') + '</span></div>';
                    return;
                }

                var html = '';
                events.slice(0, 15).forEach(function (ev) {
                    var time = ev.created_at || ev.timestamp || '';
                    html += '<div class="widget-feed-item">' +
                        '<div class="widget-feed-time">' + esc(timeSince(time)) + '</div>' +
                        '<div class="widget-feed-text">' + esc(ev.action || ev.event_type || '') + ' — ' + esc(ev.details || ev.description || '') + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 8. Notes (sticky)
    register('notes', {
        name: t('desktop.widget_notes'),
        icon: 'sticky_note_2',
        color: '#d29922',
        category: 'general',
        description: 'Personal sticky note',
        defaultSize: { w: 260, h: 240 },
        minSize: { w: 180, h: 140 },
        render: function (body, config) {
            body.innerHTML = '<textarea class="widget-notes-textarea" placeholder="' + esc(t('desktop.notes_placeholder')) + '"></textarea>';
            var ta = body.querySelector('.widget-notes-textarea');
            ta.value = config.text || '';
            var debounce = null;
            ta.addEventListener('input', function () {
                clearTimeout(debounce);
                debounce = setTimeout(function () {
                    config.text = ta.value;
                    // Trigger layout save through widget engine
                    if (window.DesktopWidgets && window.DesktopWidgets.getWidgets) {
                        // save is triggered by config change
                        localStorage.setItem('bd_widget_layout', JSON.stringify(
                            Array.from(window.DesktopWidgets.getWidgets().values())
                        ));
                    }
                }, 500);
            });
        },
        configForm: function (config) {
            return [
                { key: 'text', label: 'Note text', type: 'textarea' }
            ];
        }
    });

    // 9. Network Monitor
    register('network-monitor', {
        name: t('desktop.widget_network_monitor'),
        icon: 'wifi',
        color: '#3fb950',
        category: 'monitoring',
        description: 'Network target ping status',
        defaultSize: { w: 300, h: 240 },
        minSize: { w: 240, h: 180 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div class="widget-net-targets"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/network/targets').then(function (data) {
                var targets = data;
                if (data && data.data) targets = data.data;
                if (!Array.isArray(targets)) { targets = []; }

                var container = body.querySelector('.widget-net-targets');
                if (!container) return;
                if (!targets.length) {
                    container.innerHTML = '<div class="widget-empty"><span class="material-icons">wifi</span><span>' + t('desktop.label_no_targets') + '</span></div>';
                    return;
                }

                var html = '';
                targets.slice(0, 10).forEach(function (tgt) {
                    var status = tgt.is_up ? 'up' : 'down';
                    html += '<div class="widget-net-target">' +
                        '<div class="widget-net-status ' + status + '"></div>' +
                        '<div class="widget-net-name">' + esc(tgt.name || tgt.host) + '</div>' +
                        '<div class="widget-net-latency">' + (tgt.avg_latency != null ? tgt.avg_latency + 'ms' : '-') + '</div>' +
                    '</div>';
                });
                container.innerHTML = html;
            }).catch(function () {
                var container = body.querySelector('.widget-net-targets');
                if (container) container.innerHTML = '<div class="widget-empty"><span class="material-icons">wifi_off</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // 10. Tickets Summary
    register('tickets-summary', {
        name: t('desktop.widget_tickets_summary'),
        icon: 'confirmation_number',
        color: '#f85149',
        category: 'tools',
        description: 'Open and resolved ticket counts',
        defaultSize: { w: 260, h: 190 },
        minSize: { w: 200, h: 150 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_open') + '</span><span class="widget-tickets-count" style="color:#f85149" id="tickets-open">-</span></div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_in_progress') + '</span><span class="widget-tickets-count" style="color:#d29922" id="tickets-progress">-</span></div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_resolved') + '</span><span class="widget-tickets-count" style="color:#3fb950" id="tickets-resolved">-</span></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/tickets/stats').then(function (data) {
                if (!data) return;
                var open = body.querySelector('#tickets-open');
                var prog = body.querySelector('#tickets-progress');
                var res  = body.querySelector('#tickets-resolved');
                if (open) open.textContent = data.open_count || data.open || 0;
                if (prog) prog.textContent = data.in_progress_count || data.in_progress || 0;
                if (res)  res.textContent = data.resolved_count || data.resolved || 0;
            }).catch(function () {});
        }
    });

    // 11. iFrame
    register('iframe', {
        name: t('desktop.widget_iframe'),
        icon: 'language',
        color: '#8b949e',
        category: 'general',
        description: 'Embed any URL in a widget',
        defaultSize: { w: 400, h: 300 },
        minSize: { w: 200, h: 150 },
        render: function (body, config) {
            var url = config.url || '';
            if (url) {
                body.style.padding = '0';
                body.innerHTML = '<iframe class="widget-iframe" src="' + esc(url) + '" sandbox="allow-same-origin allow-scripts"></iframe>';
            } else {
                body.innerHTML = '<div class="widget-empty"><span class="material-icons">language</span><span>' + t('desktop.label_set_url') + '</span></div>';
            }
        },
        configForm: function (config) {
            return [
                { key: 'url', label: 'URL', type: 'text' }
            ];
        }
    });

    // 12. CDAP Integration Widget
    register('cdap-devices', {
        name: t('desktop.widget_cdap_devices'),
        icon: 'developer_board',
        color: '#bc8cff',
        category: 'devices',
        description: 'Connected CDAP devices & widgets',
        defaultSize: { w: 320, h: 260 },
        minSize: { w: 240, h: 180 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/cdap/devices').then(function (data) {
                var devices = data;
                if (data && data.data) devices = data.data;
                if (!Array.isArray(devices)) devices = [];

                var list = body.querySelector('.widget-device-list');
                if (!list) return;
                if (!devices.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">developer_board</span><span>' + t('desktop.label_no_cdap_devices') + '</span></div>';
                    return;
                }

                var html = '';
                devices.forEach(function (d) {
                    var status = d.connected ? 'online' : 'offline';
                    html += '<div class="widget-device-row">' +
                        '<div class="widget-device-dot ' + status + '"></div>' +
                        '<div class="widget-device-id">' + esc(d.id || d.device_id || '') + '</div>' +
                        '<div class="widget-device-name">' + esc(d.name || d.hostname || '-') + '</div>' +
                        '<div class="widget-device-platform">' + esc(d.type || d.device_type || '') + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {
                var list = body.querySelector('.widget-device-list');
                if (list) list.innerHTML = '<div class="widget-empty"><span class="material-icons">developer_board</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 13. Uptime Timer ============

    register('uptime', {
        name: t('desktop.widget_uptime'),
        icon: 'timer',
        color: '#58a6ff',
        category: 'monitoring',
        description: 'Server uptime counter',
        defaultSize: { w: 200, h: 160 },
        minSize: { w: 160, h: 120 },
        render: function (body) {
            body.innerHTML = '<div class="widget-uptime">' +
                '<div class="widget-uptime-value">--:--:--</div>' +
                '<div class="widget-uptime-label">' + t('desktop.label_server_uptime') + '</div></div>';
            body._uptimeStart = null;
            body._uptimeBase = 0;
            var self = this;
            this._fetch(body);
            body._uptimeTimer = setInterval(function () { self._tick(body); }, 1000);
        },
        _fetch: function (body) {
            apiGet('/api/server/status').then(function (d) {
                if (d && d.uptime) { body._uptimeBase = parseInt(d.uptime, 10) || 0; body._uptimeStart = Date.now(); }
                else if (d && d.started_at) { body._uptimeStart = Date.now(); body._uptimeBase = Math.floor((Date.now() - new Date(d.started_at).getTime()) / 1000); }
            }).catch(function () {});
        },
        _tick: function (body) {
            var s = body._uptimeBase;
            if (body._uptimeStart) s = body._uptimeBase + Math.floor((Date.now() - body._uptimeStart) / 1000);
            if (!s && s !== 0) return;
            var h = String(Math.floor(s / 3600)).padStart(2, '0');
            var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
            var sec = String(s % 60).padStart(2, '0');
            var el = body.querySelector('.widget-uptime-value');
            if (el) el.textContent = h + ':' + m + ':' + sec;
        },
        update: function (body) { this._fetch(body); },
        destroy: function (body) {
            if (body && body._uptimeTimer) { clearInterval(body._uptimeTimer); body._uptimeTimer = null; }
        }
    });

    // ============ 14. Port Status Table ============

    // ============ 14. Port Status (deprecated — merged into server-health) ============

    register('port-status', {
        name: t('desktop.widget_port_status'),
        icon: 'lan',
        color: '#79c0ff',
        category: 'monitoring',
        description: 'Network port status (use Server Info instead)',
        defaultSize: { w: 380, h: 220 },
        minSize: { w: 300, h: 160 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-empty"><span class="material-icons">info</span><span>' + t('desktop.label_merged_server_info') + '</span></div>';
        },
        update: function () {}
    });

    // ============ 15. Device Icon Grid ============

    register('device-grid', {
        name: t('desktop.widget_device_grid'),
        icon: 'grid_view',
        color: '#3fb950',
        category: 'devices',
        description: 'Device icons with status indicators',
        defaultSize: { w: 340, h: 240 },
        minSize: { w: 260, h: 160 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-grid-container"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = data && data.devices ? data.devices : (Array.isArray(data) ? data : []);
                var c = body.querySelector('.widget-device-grid-container');
                if (!c) return;
                if (!peers.length) {
                    c.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }
                var pi = { windows: 'laptop_windows', linux: 'computer', mac: 'laptop_mac', macos: 'laptop_mac', android: 'phone_android', ios: 'phone_iphone' };
                var html = '';
                peers.slice(0, 24).forEach(function (p) {
                    var on = p.live_online || p.online || false;
                    var plat = (p.platform || p.os || '').toLowerCase();
                    var icon = 'devices';
                    for (var k in pi) { if (plat.indexOf(k) !== -1) { icon = pi[k]; break; } }
                    html += '<div class="widget-dg-card ' + (on ? 'online' : 'offline') + '" title="' + esc(p.id + ' — ' + (p.hostname || '')) + '">' +
                        '<span class="material-icons widget-dg-icon">' + icon + '</span>' +
                        '<div class="widget-dg-name">' + esc(p.hostname || p.id || '-') + '</div>' +
                        '<div class="widget-dg-status">' + (on ? t('desktop.label_online') : t('desktop.label_offline')) + '</div></div>';
                });
                c.innerHTML = html;
            }).catch(function () {});
        }
    });

    // ============ 16. Multi-Gauge Cluster ============

    register('multi-gauge', {
        name: t('desktop.widget_multi_gauge'),
        icon: 'donut_large',
        color: '#f0883e',
        category: 'monitoring',
        description: 'Multiple resource gauges',
        defaultSize: { w: 400, h: 180 },
        minSize: { w: 320, h: 140 },
        updateInterval: 10000,
        render: function (body) {
            var names = [t('desktop.label_online'), t('desktop.label_offline'), t('desktop.label_banned'), t('desktop.label_active'), t('desktop.label_total')];
            var html = '<div class="widget-multi-gauge">';
            names.forEach(function (n, i) {
                html += '<div class="widget-mg-item" data-idx="' + i + '">' +
                    '<div class="widget-mg-ring">' + buildGaugeSVG(0, 64) + '<div class="widget-mg-value">-</div></div>' +
                    '<div class="widget-mg-label">' + n + '</div></div>';
            });
            body.innerHTML = html + '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var t = d.total || 1;
                var vals = [
                    { idx: 0, pct: Math.round(((d.online || 0) / t) * 100), raw: d.online || 0 },
                    { idx: 1, pct: Math.round(((d.offline || 0) / t) * 100), raw: d.offline || 0 },
                    { idx: 2, pct: Math.round(((d.banned || 0) / t) * 100), raw: d.banned || 0 },
                    { idx: 3, pct: Math.round(((d.withNotes || 0) / t) * 100), raw: d.withNotes || 0 },
                    { idx: 4, pct: 100, raw: d.total || 0 }
                ];
                vals.forEach(function (v) {
                    var item = body.querySelector('[data-idx="' + v.idx + '"]');
                    if (!item) return;
                    var ring = item.querySelector('.widget-mg-ring');
                    var val = item.querySelector('.widget-mg-value');
                    if (ring) {
                        var svg = ring.querySelector('svg');
                        var tmp = document.createElement('div');
                        tmp.innerHTML = buildGaugeSVG(v.pct, 64);
                        if (svg && tmp.firstChild) ring.replaceChild(tmp.firstChild, svg);
                    }
                    if (val) val.textContent = v.raw;
                });
            }).catch(function () {});
        }
    });

    // ============ 17. Weekly Activity Chart ============

    register('weekly-chart', {
        name: t('desktop.widget_weekly_chart'),
        icon: 'bar_chart',
        color: '#bc8cff',
        category: 'monitoring',
        description: 'Daily device activity bars',
        defaultSize: { w: 340, h: 200 },
        minSize: { w: 260, h: 160 },
        updateInterval: 60000,
        render: function (body) {
            body.innerHTML = '<div class="widget-weekly"><div class="widget-weekly-bars"></div></div>';
            this._draw(body);
        },
        _draw: function (body) {
            var c = body.querySelector('.widget-weekly-bars');
            if (!c) return;
            var days = [t('time.day_mon'), t('time.day_tue'), t('time.day_wed'), t('time.day_thu'), t('time.day_fri'), t('time.day_sat'), t('time.day_sun')];
            var dow = new Date().getDay();
            var todayIdx = dow === 0 ? 6 : dow - 1;
            var html = '';
            days.forEach(function (d, i) {
                var h1 = 30 + (i * 13) % 60;
                var h2 = 20 + ((i + 3) * 17) % 50;
                html += '<div class="widget-wb-col">' +
                    '<div class="widget-wb-bars">' +
                        '<div class="widget-wb-bar online" style="height:' + h1 + '%"></div>' +
                        '<div class="widget-wb-bar offline" style="height:' + h2 + '%"></div>' +
                    '</div>' +
                    '<div class="widget-wb-label' + (i === todayIdx ? ' today' : '') + '">' + d + '</div></div>';
            });
            c.innerHTML = html;
        },
        update: function (body) { this._draw(body); }
    });

    // ============ 18. Quick Controls ============

    register('quick-controls', {
        name: t('desktop.widget_quick_controls'),
        icon: 'tune',
        color: '#d29922',
        category: 'devices',
        description: 'Device management shortcuts',
        defaultSize: { w: 400, h: 280 },
        minSize: { w: 300, h: 200 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-qc"><div class="widget-qc-filter">' +
                '<input type="text" class="widget-qc-search" placeholder="' + t('desktop.label_filter_devices') + '">' +
                '<div class="widget-qc-pills">' +
                    '<button class="widget-qc-pill active" data-filter="all">' + t('desktop.label_all') + '</button>' +
                    '<button class="widget-qc-pill" data-filter="online">' + t('desktop.label_online') + '</button>' +
                    '<button class="widget-qc-pill" data-filter="offline">' + t('desktop.label_offline') + '</button>' +
                '</div></div>' +
                '<div class="widget-qc-list"><div class="widget-loading" style="height:40px"></div></div></div>';
            // Filter pills
            body.querySelector('.widget-qc-pills').addEventListener('click', function (e) {
                var pill = e.target.closest('.widget-qc-pill');
                if (!pill) return;
                body.querySelectorAll('.widget-qc-pill').forEach(function (p) { p.classList.remove('active'); });
                pill.classList.add('active');
                _filterQC(body);
            });
            // Search
            body.querySelector('.widget-qc-search').addEventListener('input', function () { _filterQC(body); });
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = (data && data.devices ? data.devices : []);
                var c = body.querySelector('.widget-qc-list');
                if (!c) return;
                if (!peers.length) {
                    c.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }
                var pi = { windows: 'laptop_windows', linux: 'computer', mac: 'laptop_mac', macos: 'laptop_mac', android: 'phone_android', ios: 'phone_iphone' };
                var html = '';
                peers.forEach(function (p) {
                    var on = p.live_online || p.online || false;
                    var banned = p.banned || false;
                    var plat = (p.platform || p.os || '').toLowerCase();
                    var icon = 'devices';
                    for (var k in pi) { if (plat.indexOf(k) !== -1) { icon = pi[k]; break; } }
                    var name = p.hostname || p.id || '-';
                    html += '<div class="widget-qc-row' + (on ? ' online' : ' offline') + (banned ? ' banned' : '') + '" data-id="' + esc(p.id) + '" data-status="' + (on ? 'online' : 'offline') + '" data-name="' + esc(name.toLowerCase()) + '">' +
                        '<span class="material-icons widget-qc-icon">' + icon + '</span>' +
                        '<div class="widget-qc-info">' +
                            '<div class="widget-qc-name">' + esc(name) + '</div>' +
                            '<div class="widget-qc-id">' + esc(p.id) + (banned ? ' <span class="widget-qc-badge ban">' + t('desktop.label_banned') + '</span>' : '') + '</div>' +
                        '</div>' +
                        '<div class="widget-qc-actions">' +
                            '<button class="widget-qc-btn" data-action="toggle-ban" title="' + (banned ? t('desktop.label_unban') : t('desktop.label_ban')) + '"><span class="material-icons">' + (banned ? 'lock_open' : 'block') + '</span></button>' +
                            (on ? '<button class="widget-qc-btn connect" data-action="connect" title="' + t('desktop.label_connect') + '"><span class="material-icons">launch</span></button>' : '') +
                        '</div></div>';
                });
                c.innerHTML = html;
                _filterQC(body);
                // Action handlers
                c.querySelectorAll('.widget-qc-btn').forEach(function (btn) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var row = btn.closest('.widget-qc-row');
                        var id = row ? row.dataset.id : '';
                        var action = btn.dataset.action;
                        if (action === 'connect' && id) {
                            window.open('rustdesk://' + id, '_blank');
                        } else if (action === 'toggle-ban' && id) {
                            var isBanned = row.classList.contains('banned');
                            var url = '/api/devices/' + encodeURIComponent(id) + (isBanned ? '/unban' : '/ban');
                            fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': (window.BetterDesk || {}).csrfToken || '' } })
                                .then(function () { btn.closest('.widget-qc-row').classList.toggle('banned'); })
                                .catch(function () {});
                        }
                    });
                });
            }).catch(function () {});
        }
    });

    function _filterQC(body) {
        var search = (body.querySelector('.widget-qc-search') || {}).value || '';
        search = search.toLowerCase();
        var activePill = body.querySelector('.widget-qc-pill.active');
        var filter = activePill ? activePill.dataset.filter : 'all';
        body.querySelectorAll('.widget-qc-row').forEach(function (row) {
            var matchFilter = filter === 'all' || row.dataset.status === filter;
            var matchSearch = !search || (row.dataset.name || '').indexOf(search) !== -1 || (row.dataset.id || '').toLowerCase().indexOf(search) !== -1;
            row.style.display = (matchFilter && matchSearch) ? '' : 'none';
        });
    }

    // ============ 19. Bandwidth Display ============

    register('bandwidth', {
        name: t('desktop.widget_bandwidth'),
        icon: 'speed',
        color: '#58a6ff',
        category: 'monitoring',
        description: 'Relay bandwidth & session metrics',
        defaultSize: { w: 280, h: 200 },
        minSize: { w: 220, h: 160 },
        updateInterval: 10000,
        _prevBytes: 0,
        _prevTime: 0,
        render: function (body) {
            body.innerHTML = '<div class="widget-bandwidth">' +
                '<div class="widget-bw-item">' +
                    '<div class="widget-bw-header"><span class="material-icons" style="color:#3fb950">swap_vert</span><span>' + t('desktop.label_throughput') + '</span></div>' +
                    '<div class="widget-bw-value" data-bw="speed">-</div>' +
                    '<div class="widget-bw-bar"><div class="widget-bw-fill download" data-bar="speed" style="width:0%"></div></div></div>' +
                '<div class="widget-bw-item">' +
                    '<div class="widget-bw-header"><span class="material-icons" style="color:#58a6ff">cable</span><span>' + t('desktop.label_active_relays') + '</span></div>' +
                    '<div class="widget-bw-value" data-bw="relays">-</div>' +
                    '<div class="widget-bw-bar"><div class="widget-bw-fill upload" data-bar="relays" style="width:0%"></div></div></div>' +
                '<div style="display:flex;gap:12px;margin-top:4px;">' +
                    '<div class="widget-bw-stat"><span class="widget-bw-stat-label">' + t('desktop.label_total_relayed') + '</span><span class="widget-bw-stat-val" data-bw="total">-</span></div>' +
                    '<div class="widget-bw-stat"><span class="widget-bw-stat-label">' + t('desktop.label_total_bytes') + '</span><span class="widget-bw-stat-val" data-bw="bytes">-</span></div>' +
                '</div></div>';
        },
        update: function (body) {
            var self = this;
            apiGet('/api/server/bandwidth').then(function (data) {
                if (!data) return;
                var relays = data.relay_active || 0;
                var bytes = data.bytes_transferred || 0;
                var sessions = data.active_sessions || 0;
                var totalRelayed = data.total_relayed || 0;
                // Calculate speed (bytes/sec delta)
                var now = Date.now();
                var speed = 0;
                if (self._prevTime && self._prevBytes) {
                    var dt = (now - self._prevTime) / 1000;
                    if (dt > 0) speed = Math.max(0, (bytes - self._prevBytes) / dt);
                }
                self._prevBytes = bytes;
                self._prevTime = now;
                // Format speed
                var speedStr;
                if (speed >= 1073741824) speedStr = (speed / 1073741824).toFixed(1) + ' GB/s';
                else if (speed >= 1048576) speedStr = (speed / 1048576).toFixed(1) + ' MB/s';
                else if (speed >= 1024) speedStr = (speed / 1024).toFixed(1) + ' KB/s';
                else speedStr = Math.round(speed) + ' B/s';
                // Format total bytes
                var bytesStr;
                if (bytes >= 1073741824) bytesStr = (bytes / 1073741824).toFixed(1) + ' GB';
                else if (bytes >= 1048576) bytesStr = (bytes / 1048576).toFixed(1) + ' MB';
                else if (bytes >= 1024) bytesStr = (bytes / 1024).toFixed(1) + ' KB';
                else bytesStr = bytes + ' B';
                // Update DOM
                var sv = body.querySelector('[data-bw="speed"]');
                var rv = body.querySelector('[data-bw="relays"]');
                var tv = body.querySelector('[data-bw="total"]');
                var bv = body.querySelector('[data-bw="bytes"]');
                var sb = body.querySelector('[data-bar="speed"]');
                var rb = body.querySelector('[data-bar="relays"]');
                if (sv) sv.textContent = speedStr;
                if (rv) rv.textContent = relays + ' active / ' + sessions + ' sessions';
                if (tv) tv.textContent = totalRelayed;
                if (bv) bv.textContent = bytesStr;
                // Bar: speed capped at 10 MB/s for visual
                if (sb) sb.style.width = Math.min(100, (speed / 10485760) * 100) + '%';
                // Bar: relays capped at 50 for visual
                if (rb) rb.style.width = Math.min(100, (relays / 50) * 100) + '%';
            }).catch(function () {});
        }
    });

    // ============ 20. Connection Stats Table ============

    register('connection-stats', {
        name: t('desktop.widget_connection_stats'),
        icon: 'table_chart',
        color: '#8b949e',
        category: 'monitoring',
        description: 'Tabular connection statistics',
        defaultSize: { w: 380, h: 220 },
        minSize: { w: 300, h: 160 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div class="widget-stats-table">' +
                '<div class="widget-stats-header"><span>' + t('desktop.label_metric') + '</span><span>' + t('desktop.label_count') + '</span><span>%</span></div>' +
                '<div class="widget-stats-body"><div class="widget-loading" style="height:40px"></div></div></div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var tot = d.total || 1;
                var rows = [
                    { label: t('desktop.label_total_devices'), count: d.total || 0, pct: '100%' },
                    { label: t('desktop.label_online'), count: d.online || 0, pct: Math.round(((d.online || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_offline'), count: d.offline || 0, pct: Math.round(((d.offline || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_banned'), count: d.banned || 0, pct: Math.round(((d.banned || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_with_notes'), count: d.withNotes || 0, pct: Math.round(((d.withNotes || 0) / tot) * 100) + '%' }
                ];
                var c = body.querySelector('.widget-stats-body');
                if (!c) return;
                var html = '';
                rows.forEach(function (r) {
                    html += '<div class="widget-stats-row">' +
                        '<span class="widget-stats-label">' + esc(r.label) + '</span>' +
                        '<span class="widget-stats-count">' + r.count + '</span>' +
                        '<span class="widget-stats-pct">' + r.pct + '</span></div>';
                });
                c.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 18. Weather
    register('weather', {
        name: t('desktop.widget_weather'),
        icon: 'cloud',
        color: '#58a6ff',
        category: 'general',
        description: 'Weather conditions from wttr.in',
        defaultSize: { w: 280, h: 200 },
        minSize: { w: 220, h: 160 },
        _interval: null,
        render: function (body) {
            body.innerHTML = '<div class="widget-weather-loading" style="text-align:center;padding:20px">' +
                '<span class="material-icons" style="font-size:32px;color:#58a6ff">cloud_queue</span>' +
                '<div style="margin-top:8px;color:var(--text-secondary)">' + esc(t('common.loading')) + '</div></div>';
            this._fetchWeather(body);
            var self = this;
            this._interval = setInterval(function () { self._fetchWeather(body); }, 600000);
        },
        update: function (body) { this._fetchWeather(body); },
        destroy: function () { if (this._interval) { clearInterval(this._interval); this._interval = null; } },
        _fetchWeather: function (body) {
            var loc = (this.config && this.config.location) || '';
            var url = 'https://wttr.in/' + encodeURIComponent(loc) + '?format=j1';
            fetch(url).then(function (r) { return r.json(); }).then(function (data) {
                var cur = data.current_condition && data.current_condition[0];
                if (!cur) { body.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">No data</div>'; return; }
                var temp = cur.temp_C || '?';
                var desc = (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '';
                var humidity = cur.humidity || '?';
                var wind = cur.windspeedKmph || '?';
                var icon = _weatherIcon(desc);
                var area = (data.nearest_area && data.nearest_area[0] && data.nearest_area[0].areaName &&
                    data.nearest_area[0].areaName[0] && data.nearest_area[0].areaName[0].value) || loc || 'Local';
                body.innerHTML = '<div style="padding:12px">' +
                    '<div style="display:flex;align-items:center;gap:12px">' +
                    '<span class="material-icons" style="font-size:40px;color:#58a6ff">' + icon + '</span>' +
                    '<div>' +
                    '<div style="font-size:28px;font-weight:700">' + esc(temp) + '°C</div>' +
                    '<div style="font-size:12px;color:var(--text-secondary)">' + esc(desc) + '</div>' +
                    '</div></div>' +
                    '<div style="margin-top:12px;font-size:12px;color:var(--text-secondary)">' + esc(area) + '</div>' +
                    '<div style="display:flex;gap:16px;margin-top:8px;font-size:12px">' +
                    '<span>💧 ' + esc(humidity) + '%</span>' +
                    '<span>🌬️ ' + esc(wind) + ' km/h</span></div></div>';
            }).catch(function () {
                body.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">Weather unavailable</div>';
            });
        },
        configFields: [
            { key: 'location', label: 'Location (city or coordinates)', type: 'text', placeholder: 'e.g. Warsaw or 52.23,21.01' }
        ]
    });

    function _weatherIcon(desc) {
        var d = (desc || '').toLowerCase();
        if (d.includes('sun') || d.includes('clear')) return 'wb_sunny';
        if (d.includes('cloud') && d.includes('part')) return 'partly_cloudy_day';
        if (d.includes('cloud') || d.includes('overcast')) return 'cloud';
        if (d.includes('rain') || d.includes('drizzle')) return 'water_drop';
        if (d.includes('snow') || d.includes('sleet')) return 'ac_unit';
        if (d.includes('thunder') || d.includes('storm')) return 'thunderstorm';
        if (d.includes('fog') || d.includes('mist')) return 'foggy';
        return 'cloud_queue';
    }

    // 19. World Clock
    register('world-clock', {
        name: t('desktop.widget_world_clock'),
        icon: 'public',
        color: '#d2a8ff',
        category: 'general',
        description: 'Multiple time zones display',
        defaultSize: { w: 260, h: 200 },
        minSize: { w: 200, h: 140 },
        _interval: null,
        render: function (body) {
            var self = this;
            this._renderClocks(body);
            this._interval = setInterval(function () { self._renderClocks(body); }, 1000);
        },
        update: function (body) { this._renderClocks(body); },
        destroy: function () { if (this._interval) { clearInterval(this._interval); this._interval = null; } },
        _renderClocks: function (body) {
            var zones = (this.config && this.config.zones) || 'America/New_York,Europe/London,Europe/Warsaw,Asia/Tokyo';
            var list = zones.split(',').map(function (z) { return z.trim(); }).filter(Boolean);
            var html = '<div style="padding:8px">';
            list.forEach(function (tz) {
                var label = tz.split('/').pop().replace(/_/g, ' ');
                var time;
                try {
                    time = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                } catch (e) {
                    time = '??:??';
                }
                html += '<div style="display:flex;justify-content:space-between;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.05)">' +
                    '<span style="font-size:13px;color:var(--text-secondary)">' + esc(label) + '</span>' +
                    '<span style="font-size:14px;font-weight:600;font-variant-numeric:tabular-nums">' + esc(time) + '</span></div>';
            });
            html += '</div>';
            body.innerHTML = html;
        },
        configFields: [
            { key: 'zones', label: 'Time zones (comma-separated)', type: 'text', placeholder: 'America/New_York,Europe/Warsaw' }
        ]
    });

    // 20. Bookmarks / Link Launcher
    register('bookmarks', {
        name: t('desktop.widget_bookmarks'),
        icon: 'bookmarks',
        color: '#f0883e',
        category: 'tools',
        description: 'Quick-access URL shortcuts',
        defaultSize: { w: 280, h: 200 },
        minSize: { w: 200, h: 120 },
        render: function (body) {
            var links = (this.config && this.config.links) || 'Grafana|http://localhost:3000,Portainer|http://localhost:9000,Router|http://192.168.1.1';
            var items = links.split(',').map(function (l) {
                var parts = l.trim().split('|');
                return { name: parts[0] || 'Link', url: parts[1] || '#' };
            });
            var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;padding:10px">';
            items.forEach(function (item) {
                html += '<a href="' + esc(item.url) + '" target="_blank" rel="noopener" ' +
                    'class="widget-bookmark-link" ' +
                    'style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;' +
                    'border-radius:8px;background:rgba(255,255,255,0.03);text-decoration:none;color:inherit;' +
                    'transition:background .15s">' +
                    '<span class="material-icons" style="font-size:24px;color:#f0883e">link</span>' +
                    '<span style="font-size:11px;text-align:center;word-break:break-word">' + esc(item.name) + '</span></a>';
            });
            html += '</div>';
            body.innerHTML = html;
            body.querySelectorAll('.widget-bookmark-link').forEach(function (link) {
                link.addEventListener('mouseenter', function () {
                    link.style.background = 'rgba(255,255,255,0.08)';
                });
                link.addEventListener('mouseleave', function () {
                    link.style.background = 'rgba(255,255,255,0.03)';
                });
            });
        },
        configFields: [
            { key: 'links', label: 'Links (Name|URL, comma-separated)', type: 'text', placeholder: 'Grafana|http://localhost:3000' }
        ]
    });

    // 21. User Sessions
    register('user-sessions', {
        name: t('desktop.widget_user_sessions'),
        icon: 'group',
        color: '#3fb950',
        category: 'monitoring',
        description: 'Currently logged-in operators',
        defaultSize: { w: 300, h: 200 },
        minSize: { w: 240, h: 140 },
        _interval: null,
        render: function (body) {
            this._fetchSessions(body);
            var self = this;
            this._interval = setInterval(function () { self._fetchSessions(body); }, 15000);
        },
        update: function (body) { this._fetchSessions(body); },
        destroy: function () { if (this._interval) { clearInterval(this._interval); this._interval = null; } },
        _fetchSessions: function (body) {
            apiGet('/api/users').then(function (res) {
                var users = (res && res.data && res.data.users) || [];
                if (!users.length) {
                    body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary)">No active users</div>';
                    return;
                }
                var html = '<div style="padding:8px">';
                users.forEach(function (u) {
                    var initial = (u.username || '?')[0].toUpperCase();
                    var roleBadge = u.role === 'admin'
                        ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(88,166,255,.15);color:#58a6ff">admin</span>'
                        : '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(63,185,80,.15);color:#3fb950">operator</span>';
                    html += '<div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.05)">' +
                        '<div style="width:28px;height:28px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:white">' +
                        esc(initial) + '</div>' +
                        '<div style="flex:1"><div style="font-size:13px;font-weight:500">' + esc(u.username) + '</div></div>' +
                        roleBadge + '</div>';
                });
                html += '</div>';
                body.innerHTML = html;
            }).catch(function () {
                body.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">Could not load users</div>';
            });
        }
    });

    // 22. Alert Feed
    register('alert-feed', {
        name: t('desktop.widget_alert_feed'),
        icon: 'notifications_active',
        color: '#f85149',
        category: 'monitoring',
        description: 'Security alerts and events',
        defaultSize: { w: 340, h: 260 },
        minSize: { w: 260, h: 180 },
        _interval: null,
        render: function (body) {
            this._fetchAlerts(body);
            var self = this;
            this._interval = setInterval(function () { self._fetchAlerts(body); }, 30000);
        },
        update: function (body) { this._fetchAlerts(body); },
        destroy: function () { if (this._interval) { clearInterval(this._interval); this._interval = null; } },
        _fetchAlerts: function (body) {
            apiGet('/api/audit-log?limit=10').then(function (res) {
                var logs = (res && res.data && res.data.logs) || [];
                if (!logs.length) {
                    body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary)">' +
                        '<span class="material-icons" style="font-size:28px">check_circle</span><div style="margin-top:4px">No recent alerts</div></div>';
                    return;
                }
                var html = '<div style="padding:4px;max-height:220px;overflow-y:auto">';
                logs.forEach(function (log) {
                    var color = (log.action || '').includes('fail') || (log.action || '').includes('ban') ? '#f85149' :
                        (log.action || '').includes('login') ? '#3fb950' : '#8b949e';
                    var icon = (log.action || '').includes('ban') ? 'block' :
                        (log.action || '').includes('fail') ? 'warning' :
                        (log.action || '').includes('login') ? 'login' : 'info';
                    html += '<div style="display:flex;gap:8px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px">' +
                        '<span class="material-icons" style="font-size:16px;color:' + color + ';margin-top:1px">' + icon + '</span>' +
                        '<div style="flex:1;min-width:0">' +
                        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(log.action || '') + '</div>' +
                        '<div style="color:var(--text-tertiary);font-size:11px">' + esc(log.details || '') + '</div></div>' +
                        '<div style="white-space:nowrap;color:var(--text-tertiary);font-size:10px">' + timeSince(log.created_at) + '</div></div>';
                });
                html += '</div>';
                body.innerHTML = html;
            }).catch(function () {
                body.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">Could not load alerts</div>';
            });
        }
    });

    // ============ 23. Calendar / Agenda ============

    register('calendar', {
        name: t('desktop.widget_calendar'),
        icon: 'event',
        color: '#d2a8ff',
        category: 'general',
        description: 'Simple calendar with local event entries',
        defaultSize: { w: 320, h: 340 },
        minSize: { w: 260, h: 260 },
        _STORAGE_KEY: 'bd_widget_calendar_events',
        render: function (body, config) {
            this._month = new Date().getMonth();
            this._year = new Date().getFullYear();
            this._renderCalendar(body);
        },
        _loadEvents: function () {
            try { return JSON.parse(localStorage.getItem(this._STORAGE_KEY) || '[]'); }
            catch (e) { return []; }
        },
        _saveEvents: function (evts) {
            localStorage.setItem(this._STORAGE_KEY, JSON.stringify(evts));
        },
        _renderCalendar: function (body) {
            var self = this;
            var year = this._year;
            var month = this._month;
            var today = new Date();
            var first = new Date(year, month, 1);
            var last = new Date(year, month + 1, 0);
            var startDay = first.getDay() === 0 ? 6 : first.getDay() - 1;
            var days = last.getDate();
            var events = this._loadEvents();
            var monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

            var html = '<div class="widget-cal">' +
                '<div class="widget-cal-header">' +
                '<button class="widget-cal-nav" data-dir="-1"><span class="material-icons">chevron_left</span></button>' +
                '<span class="widget-cal-title">' + esc(monthName) + '</span>' +
                '<button class="widget-cal-nav" data-dir="1"><span class="material-icons">chevron_right</span></button></div>' +
                '<div class="widget-cal-grid">';
            var dayNames = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
            dayNames.forEach(function (d) { html += '<div class="widget-cal-day-header">' + d + '</div>'; });
            for (var i = 0; i < startDay; i++) html += '<div class="widget-cal-day empty"></div>';
            for (var d = 1; d <= days; d++) {
                var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
                var isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                var hasEvent = events.some(function (ev) { return ev.date === dateStr; });
                html += '<div class="widget-cal-day' + (isToday ? ' today' : '') + (hasEvent ? ' has-event' : '') + '" data-date="' + dateStr + '">' + d + '</div>';
            }
            html += '</div>';
            // Events list for today
            var todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
            var todayEvts = events.filter(function (ev) { return ev.date === todayStr; });
            html += '<div class="widget-cal-events">';
            if (todayEvts.length) {
                todayEvts.forEach(function (ev) {
                    html += '<div class="widget-cal-event"><span class="material-icons" style="font-size:14px;color:#d2a8ff">event_note</span>' + esc(ev.title) + '</div>';
                });
            } else {
                html += '<div class="widget-cal-no-events">' + t('desktop.label_no_events') + '</div>';
            }
            html += '</div></div>';
            body.innerHTML = html;

            // Navigation
            body.querySelectorAll('.widget-cal-nav').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var dir = parseInt(btn.dataset.dir, 10);
                    self._month += dir;
                    if (self._month > 11) { self._month = 0; self._year++; }
                    if (self._month < 0) { self._month = 11; self._year--; }
                    self._renderCalendar(body);
                });
            });
            // Click day to add event
            body.querySelectorAll('.widget-cal-day:not(.empty)').forEach(function (cell) {
                cell.addEventListener('dblclick', function (e) {
                    e.stopPropagation();
                    var date = cell.dataset.date;
                    var title = prompt(t('desktop.label_event_title') || 'Event title:');
                    if (!title) return;
                    var evts = self._loadEvents();
                    evts.push({ date: date, title: title });
                    self._saveEvents(evts);
                    self._renderCalendar(body);
                });
            });
        },
        update: function (body) { this._renderCalendar(body); }
    });

    // ============ 24. System Process Monitor ============

    register('process-monitor', {
        name: t('desktop.widget_process_monitor'),
        icon: 'memory',
        color: '#f85149',
        category: 'monitoring',
        description: 'Top CPU/memory-consuming processes',
        defaultSize: { w: 380, h: 300 },
        minSize: { w: 300, h: 200 },
        updateInterval: 10000,
        render: function (body) {
            body.innerHTML = '<div class="widget-proc"><div class="widget-proc-header">' +
                '<span style="flex:2">Process</span><span style="flex:1;text-align:right">CPU</span><span style="flex:1;text-align:right">Mem</span></div>' +
                '<div class="widget-proc-list"><div class="widget-loading" style="height:40px"></div></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/system/info').then(function (data) {
                if (!data || !data.processes) return;
                var list = body.querySelector('.widget-proc-list');
                if (!list) return;
                var procs = data.processes.slice(0, 15);
                if (!procs.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">memory</span><span>' + t('desktop.label_no_data') + '</span></div>';
                    return;
                }
                var html = '';
                procs.forEach(function (p) {
                    var cpuCls = p.cpu > 80 ? 'danger' : (p.cpu > 50 ? 'warning' : '');
                    html += '<div class="widget-proc-row">' +
                        '<span class="widget-proc-name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
                        '<span class="widget-proc-cpu ' + cpuCls + '">' + (p.cpu != null ? p.cpu.toFixed(1) + '%' : '-') + '</span>' +
                        '<span class="widget-proc-mem">' + (p.mem != null ? p.mem.toFixed(1) + ' MB' : '-') + '</span></div>';
                });
                list.innerHTML = html;
            }).catch(function () {
                var list = body.querySelector('.widget-proc-list');
                if (list) list.innerHTML = '<div class="widget-empty"><span class="material-icons">error</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 25. Disk Usage Breakdown ============

    register('disk-usage', {
        name: t('desktop.widget_disk_usage'),
        icon: 'storage',
        color: '#f0883e',
        category: 'monitoring',
        description: 'Disk usage per partition',
        defaultSize: { w: 320, h: 240 },
        minSize: { w: 260, h: 180 },
        updateInterval: 60000,
        render: function (body) {
            body.innerHTML = '<div class="widget-disk-list"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/system/info').then(function (data) {
                if (!data || !data.disks) return;
                var list = body.querySelector('.widget-disk-list');
                if (!list) return;
                if (!data.disks.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">storage</span><span>' + t('desktop.label_no_data') + '</span></div>';
                    return;
                }
                var html = '';
                data.disks.forEach(function (d) {
                    var pct = d.total > 0 ? Math.round((d.used / d.total) * 100) : 0;
                    var cls = pct > 90 ? 'danger' : (pct > 75 ? 'warning' : '');
                    var totalGB = (d.total / 1073741824).toFixed(1);
                    var usedGB = (d.used / 1073741824).toFixed(1);
                    html += '<div class="widget-disk-item">' +
                        '<div class="widget-disk-info"><span class="widget-disk-mount">' + esc(d.mount || d.name) + '</span>' +
                        '<span class="widget-disk-size">' + usedGB + ' / ' + totalGB + ' GB</span></div>' +
                        '<div class="widget-disk-bar"><div class="widget-disk-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
                        '<div class="widget-disk-pct">' + pct + '%</div></div>';
                });
                list.innerHTML = html;
            }).catch(function () {
                var list = body.querySelector('.widget-disk-list');
                if (list) list.innerHTML = '<div class="widget-empty"><span class="material-icons">error</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 26. Log Viewer ============

    register('log-viewer', {
        name: t('desktop.widget_log_viewer'),
        icon: 'article',
        color: '#8b949e',
        category: 'monitoring',
        description: 'Stream recent server log lines',
        defaultSize: { w: 440, h: 300 },
        minSize: { w: 320, h: 200 },
        updateInterval: 10000,
        render: function (body) {
            body.innerHTML = '<div class="widget-log">' +
                '<div class="widget-log-toolbar">' +
                '<select class="widget-log-source">' +
                '<option value="console">Console</option>' +
                '<option value="go">Go Server</option>' +
                '</select>' +
                '<button class="widget-log-scroll-btn" title="Auto-scroll"><span class="material-icons">vertical_align_bottom</span></button></div>' +
                '<div class="widget-log-lines"></div></div>';
            body.style.overflow = 'hidden';
            var scrollBtn = body.querySelector('.widget-log-scroll-btn');
            body._autoScroll = true;
            if (scrollBtn) {
                scrollBtn.classList.add('active');
                scrollBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    body._autoScroll = !body._autoScroll;
                    scrollBtn.classList.toggle('active', body._autoScroll);
                });
            }
        },
        update: function (body) {
            var source = (body.querySelector('.widget-log-source') || {}).value || 'console';
            apiGet('/api/logs/recent?source=' + source + '&limit=50').then(function (data) {
                if (!data || !data.lines) return;
                var container = body.querySelector('.widget-log-lines');
                if (!container) return;
                var html = '';
                data.lines.forEach(function (line) {
                    var cls = '';
                    var lower = (line || '').toLowerCase();
                    if (lower.includes('error') || lower.includes('fatal')) cls = 'error';
                    else if (lower.includes('warn')) cls = 'warning';
                    else if (lower.includes('info')) cls = 'info';
                    html += '<div class="widget-log-line ' + cls + '">' + esc(line) + '</div>';
                });
                container.innerHTML = html;
                if (body._autoScroll) container.scrollTop = container.scrollHeight;
            }).catch(function () {
                var container = body.querySelector('.widget-log-lines');
                if (container) container.innerHTML = '<div class="widget-log-line error">Failed to load logs</div>';
            });
        }
    });

    // ============ 27. Speed Test ============

    register('speed-test', {
        name: t('desktop.widget_speed_test'),
        icon: 'network_check',
        color: '#3fb950',
        category: 'tools',
        description: 'Test download speed from server',
        defaultSize: { w: 280, h: 220 },
        minSize: { w: 220, h: 170 },
        _testing: false,
        render: function (body) {
            var self = this;
            body.innerHTML = '<div class="widget-speedtest">' +
                '<div class="widget-speedtest-gauge">' + buildGaugeSVG(0) +
                '<div class="widget-speedtest-value">-</div></div>' +
                '<div class="widget-speedtest-label">' + t('desktop.label_download_speed') + '</div>' +
                '<div class="widget-speedtest-stats">' +
                '<div><span class="widget-speedtest-stat-label">' + t('desktop.label_latency') + '</span><span class="widget-speedtest-stat-val" data-st="latency">-</span></div>' +
                '<div><span class="widget-speedtest-stat-label">' + t('desktop.label_server') + '</span><span class="widget-speedtest-stat-val" data-st="server">Local</span></div></div>' +
                '<button class="widget-speedtest-btn">' + t('desktop.label_run_test') + '</button></div>';
            body.querySelector('.widget-speedtest-btn').addEventListener('click', function (e) {
                e.stopPropagation();
                if (self._testing) return;
                self._runTest(body);
            });
        },
        _runTest: function (body) {
            var self = this;
            self._testing = true;
            var btn = body.querySelector('.widget-speedtest-btn');
            if (btn) btn.textContent = t('desktop.label_testing') || 'Testing...';
            // Measure latency
            var latencyStart = performance.now();
            fetch('/api/stats', { cache: 'no-store' }).then(function () {
                var latency = Math.round(performance.now() - latencyStart);
                var latEl = body.querySelector('[data-st="latency"]');
                if (latEl) latEl.textContent = latency + 'ms';
                // Download speed test — download 1MB payload
                var dlStart = performance.now();
                var testUrl = '/api/speed-test?size=1048576&_=' + Date.now();
                return fetch(testUrl, { cache: 'no-store' }).then(function (r) { return r.blob(); }).then(function (blob) {
                    var dlTime = (performance.now() - dlStart) / 1000;
                    var bytes = blob.size || 1048576;
                    var speed = bytes / dlTime; // bytes/sec
                    var mbps = (speed * 8) / 1000000;
                    var pct = Math.min(100, (mbps / 100) * 100);
                    // Update gauge
                    var ring = body.querySelector('.widget-speedtest-gauge');
                    if (ring) {
                        var svg = ring.querySelector('svg');
                        var tmp = document.createElement('div');
                        tmp.innerHTML = buildGaugeSVG(pct);
                        if (svg && tmp.firstChild) ring.replaceChild(tmp.firstChild, svg);
                    }
                    var val = body.querySelector('.widget-speedtest-value');
                    if (val) val.textContent = mbps.toFixed(1) + ' Mbps';
                    self._testing = false;
                    if (btn) btn.textContent = t('desktop.label_run_test') || 'Run Test';
                });
            }).catch(function () {
                self._testing = false;
                if (btn) btn.textContent = t('desktop.label_run_test') || 'Run Test';
            });
        }
    });

    // ============ 28. Database Stats ============

    register('database-stats', {
        name: t('desktop.widget_database_stats'),
        icon: 'table_view',
        color: '#79c0ff',
        category: 'monitoring',
        description: 'Database size, tables, and row counts',
        defaultSize: { w: 320, h: 260 },
        minSize: { w: 260, h: 180 },
        updateInterval: 60000,
        render: function (body) {
            body.innerHTML = '<div class="widget-dbstats"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/database/stats').then(function (data) {
                if (!data) return;
                var c = body.querySelector('.widget-dbstats');
                if (!c) return;
                var html = '<div class="widget-dbstats-header">' +
                    '<span class="material-icons" style="color:#79c0ff;font-size:20px">table_view</span>' +
                    '<span>' + esc(data.type || 'SQLite') + '</span>' +
                    '<span class="widget-dbstats-size">' + esc(data.size || '-') + '</span></div>' +
                    '<div class="widget-dbstats-table">' +
                    '<div class="widget-dbstats-row header"><span>' + t('desktop.label_table') + '</span><span>' + t('desktop.label_rows') + '</span></div>';
                if (data.tables && Array.isArray(data.tables)) {
                    data.tables.forEach(function (tbl) {
                        html += '<div class="widget-dbstats-row"><span>' + esc(tbl.name) + '</span><span>' + (tbl.count || 0) + '</span></div>';
                    });
                }
                html += '</div>';
                if (data.last_backup) {
                    html += '<div class="widget-dbstats-footer">' + t('desktop.label_last_backup') + ': ' + esc(timeSince(data.last_backup)) + ' ago</div>';
                }
                c.innerHTML = html;
            }).catch(function () {
                var c = body.querySelector('.widget-dbstats');
                if (c) c.innerHTML = '<div class="widget-empty"><span class="material-icons">error</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 29. Docker Containers ============

    register('docker-containers', {
        name: t('desktop.widget_docker_containers'),
        icon: 'view_in_ar',
        color: '#2496ed',
        category: 'monitoring',
        description: 'Docker container status overview',
        defaultSize: { w: 380, h: 280 },
        minSize: { w: 300, h: 200 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-docker"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/docker/containers').then(function (data) {
                if (!data || !data.containers) return;
                var c = body.querySelector('.widget-docker');
                if (!c) return;
                if (!data.containers.length) {
                    c.innerHTML = '<div class="widget-empty"><span class="material-icons">view_in_ar</span><span>' + t('desktop.label_no_containers') + '</span></div>';
                    return;
                }
                var html = '';
                data.containers.forEach(function (ct) {
                    var statusCls = ct.state === 'running' ? 'running' : (ct.state === 'exited' ? 'stopped' : 'other');
                    var icon = ct.state === 'running' ? 'play_circle' : (ct.state === 'exited' ? 'stop_circle' : 'pending');
                    html += '<div class="widget-docker-row ' + statusCls + '">' +
                        '<span class="material-icons widget-docker-status">' + icon + '</span>' +
                        '<div class="widget-docker-info">' +
                        '<div class="widget-docker-name" title="' + esc(ct.name) + '">' + esc(ct.name) + '</div>' +
                        '<div class="widget-docker-meta">' + esc(ct.image || '') +
                        (ct.ports ? ' · ' + esc(ct.ports) : '') + '</div></div>' +
                        '<div class="widget-docker-uptime">' + esc(ct.status || ct.state) + '</div></div>';
                });
                c.innerHTML = html;
            }).catch(function () {
                var c = body.querySelector('.widget-docker');
                if (c) c.innerHTML = '<div class="widget-empty"><span class="material-icons">cloud_off</span><span>' + t('desktop.label_docker_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 30. Custom Shell Command ============

    register('shell-command', {
        name: t('desktop.widget_shell_command'),
        icon: 'terminal',
        color: '#d29922',
        category: 'tools',
        description: 'Execute a predefined command and display output',
        defaultSize: { w: 400, h: 260 },
        minSize: { w: 300, h: 180 },
        render: function (body, config) {
            var cmd = config.command || '';
            var interval = parseInt(config.refreshInterval, 10) || 30;
            body.innerHTML = '<div class="widget-shell">' +
                '<div class="widget-shell-header">' +
                '<span class="material-icons" style="font-size:16px;color:#d29922">terminal</span>' +
                '<span class="widget-shell-cmd" title="' + esc(cmd) + '">' + (cmd ? '$ ' + esc(cmd) : t('desktop.label_no_command')) + '</span>' +
                '<button class="widget-shell-run" title="' + t('desktop.label_run') + '"><span class="material-icons">play_arrow</span></button></div>' +
                '<pre class="widget-shell-output">' + t('desktop.label_no_output') + '</pre></div>';
            var self = this;
            body.querySelector('.widget-shell-run').addEventListener('click', function (e) {
                e.stopPropagation();
                self._exec(body, config);
            });
            if (cmd) {
                this._exec(body, config);
                body._shellTimer = setInterval(function () { self._exec(body, config); }, interval * 1000);
            }
        },
        _exec: function (body, config) {
            var cmd = config.command || '';
            if (!cmd) return;
            var output = body.querySelector('.widget-shell-output');
            if (output) output.textContent = 'Running...';
            fetch('/api/system/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (window.BetterDesk || {}).csrfToken || '' },
                credentials: 'same-origin',
                body: JSON.stringify({ command: cmd })
            }).then(function (r) { return r.json(); }).then(function (data) {
                if (output) output.textContent = data.output || data.error || 'No output';
            }).catch(function (err) {
                if (output) output.textContent = 'Error: ' + (err.message || 'Failed');
            });
        },
        destroy: function (body) {
            if (body && body._shellTimer) { clearInterval(body._shellTimer); body._shellTimer = null; }
        },
        configFields: [
            { key: 'command', label: 'Command (admin only)', type: 'text', placeholder: 'uptime' },
            { key: 'refreshInterval', label: 'Refresh interval (seconds)', type: 'text', placeholder: '30' }
        ]
    });

    // ============ 31. Device Map ============

    register('device-map', {
        name: t('desktop.widget_device_map'),
        icon: 'map',
        color: '#3fb950',
        category: 'devices',
        description: 'Geographic map view of devices by IP',
        defaultSize: { w: 460, h: 340 },
        minSize: { w: 340, h: 240 },
        updateInterval: 120000,
        render: function (body) {
            body.innerHTML = '<div class="widget-map">' +
                '<div class="widget-map-canvas" style="position:relative;width:100%;height:100%;overflow:hidden">' +
                '<img class="widget-map-img" src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Equirectangular-projection.jpg/1280px-Equirectangular-projection.jpg" ' +
                'alt="World Map" style="width:100%;height:100%;object-fit:cover;opacity:0.3;filter:grayscale(1) brightness(0.4)" crossorigin="anonymous">' +
                '<div class="widget-map-pins"></div>' +
                '<div class="widget-map-legend">' +
                '<span class="widget-map-legend-item online"><span class="widget-map-legend-dot online"></span>' + t('desktop.label_online') + '</span>' +
                '<span class="widget-map-legend-item offline"><span class="widget-map-legend-dot offline"></span>' + t('desktop.label_offline') + '</span></div></div></div>';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = (data && data.devices ? data.devices : (Array.isArray(data) ? data : []));
                var pinsContainer = body.querySelector('.widget-map-pins');
                if (!pinsContainer) return;
                if (!peers.length) { pinsContainer.innerHTML = ''; return; }
                // Group devices by IP and show approximate positions
                var ipMap = {};
                peers.forEach(function (p) {
                    var ip = p.ip || p.socket_addr || '';
                    if (ip.includes(':')) ip = ip.split(':')[0]; // Remove port
                    if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
                        ip = 'local';
                    }
                    if (!ipMap[ip]) ipMap[ip] = { ip: ip, devices: [], online: 0 };
                    ipMap[ip].devices.push(p);
                    if (p.live_online || p.online) ipMap[ip].online++;
                });
                // Simple hash-based positioning (deterministic for same IP)
                var html = '';
                var idx = 0;
                Object.keys(ipMap).forEach(function (ip) {
                    var group = ipMap[ip];
                    var hash = 0;
                    for (var i = 0; i < ip.length; i++) hash = ((hash << 5) - hash) + ip.charCodeAt(i);
                    var x = 10 + Math.abs(hash % 80);
                    var y = 10 + Math.abs((hash * 31) % 70);
                    var online = group.online > 0;
                    var count = group.devices.length;
                    html += '<div class="widget-map-pin ' + (online ? 'online' : 'offline') + '" style="left:' + x + '%;top:' + y + '%" ' +
                        'title="' + esc(ip) + ' — ' + count + ' device(s)">' +
                        (count > 1 ? '<span class="widget-map-pin-count">' + count + '</span>' : '') + '</div>';
                    idx++;
                });
                pinsContainer.innerHTML = html;
            }).catch(function () {});
        }
    });

    // ============ 32. Remote Connect ============

    register('remote-connect', {
        name: t('desktop.widget_remote_connect') || 'Remote Connect',
        icon: 'connected_tv',
        color: '#58a6ff',
        category: 'tools',
        description: 'Quick-connect to online devices',
        defaultSize: { w: 340, h: 300 },
        minSize: { w: 260, h: 200 },
        render: function (body) {
            body.innerHTML =
                '<div style="display:flex;flex-direction:column;height:100%;gap:6px;padding:2px 0">' +
                '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
                '<input class="rc-search" type="text" placeholder="' + esc(t('desktop.label_filter_devices') || 'Filter…') + '" ' +
                'style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:5px 8px;color:inherit;font-size:12px;outline:none">' +
                '<span class="rc-count" style="font-size:11px;opacity:0.5;white-space:nowrap"></span></div>' +
                '<div class="rc-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin"></div>' +
                '<div class="rc-empty" style="display:none;text-align:center;padding:20px 8px;opacity:0.4;font-size:12px">' +
                '<span class="material-icons" style="font-size:32px;display:block;margin-bottom:6px">desktop_access_disabled</span>' +
                (t('desktop.label_no_online') || 'No online devices') + '</div></div>';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = data && data.devices ? data.devices : (Array.isArray(data) ? data : []);
                var online = peers.filter(function (p) { return p.live_online || p.online; });
                var list = body.querySelector('.rc-list');
                var empty = body.querySelector('.rc-empty');
                var countEl = body.querySelector('.rc-count');
                var search = body.querySelector('.rc-search');

                if (countEl) countEl.textContent = online.length + '/' + peers.length;

                if (!online.length) {
                    if (list) list.innerHTML = '';
                    if (empty) empty.style.display = 'block';
                    return;
                }
                if (empty) empty.style.display = 'none';

                var filter = (search && search.value || '').toLowerCase();
                var filtered = filter ? online.filter(function (p) {
                    return (p.id || '').toLowerCase().includes(filter) ||
                           (p.hostname || '').toLowerCase().includes(filter) ||
                           (p.platform || '').toLowerCase().includes(filter);
                }) : online;

                if (!list) return;
                list.innerHTML = filtered.map(function (p) {
                    var name = esc(p.hostname || p.id);
                    var platform = esc(p.platform || '');
                    var platformIcon = platform.toLowerCase().includes('windows') ? 'desktop_windows' :
                                       platform.toLowerCase().includes('linux') ? 'terminal' :
                                       platform.toLowerCase().includes('mac') ? 'laptop_mac' : 'devices';
                    return '<div class="rc-device" data-id="' + esc(p.id) + '" style="display:flex;align-items:center;gap:8px;padding:6px 8px;' +
                        'border-radius:6px;cursor:pointer;background:rgba(255,255,255,0.04);transition:background 0.15s" ' +
                        'onmouseover="this.style.background=\'rgba(88,166,255,0.12)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.04)\'">' +
                        '<span class="material-icons" style="font-size:18px;opacity:0.6">' + platformIcon + '</span>' +
                        '<div style="flex:1;min-width:0">' +
                        '<div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</div>' +
                        '<div style="font-size:10px;opacity:0.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(p.id) + (platform ? ' · ' + platform : '') + '</div></div>' +
                        '<span class="rc-dot" style="width:6px;height:6px;border-radius:50%;background:#3fb950;flex-shrink:0"></span>' +
                        '<button class="rc-connect-btn" data-id="' + esc(p.id) + '" style="background:rgba(88,166,255,0.15);border:none;' +
                        'border-radius:4px;color:#58a6ff;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap" ' +
                        'onmouseover="this.style.background=\'rgba(88,166,255,0.3)\'" onmouseout="this.style.background=\'rgba(88,166,255,0.15)\'">' +
                        (t('desktop.label_connect') || 'Connect') + '</button></div>';
                }).join('');

                // Attach search filter
                if (search && !search._rcBound) {
                    search._rcBound = true;
                    search.addEventListener('input', function () {
                        if (body._rcTimer) clearTimeout(body._rcTimer);
                        body._rcTimer = setTimeout(function () {
                            var plugin = get('remote-connect');
                            if (plugin && plugin.update) plugin.update(body);
                        }, 200);
                    });
                }

                // Attach click handlers
                list.querySelectorAll('.rc-device').forEach(function (el) {
                    el.addEventListener('click', function (e) {
                        var id = el.getAttribute('data-id');
                        if (!id) return;
                        e.stopPropagation();
                        // In desktop mode, open as a window; otherwise navigate
                        if (window.DesktopMode && window.DesktopMode.isActive && window.DesktopMode.isActive()) {
                            window.DesktopMode.openAppByRoute('/remote/' + id);
                        } else {
                            window.location.href = '/remote/' + id;
                        }
                    });
                });
            }).catch(function () {
                var empty = body.querySelector('.rc-empty');
                if (empty) empty.style.display = 'block';
            });
        }
    });

    // ============ Expose ============

    window.WidgetPlugins = {
        register: register,
        get: get,
        list: list
    };

})();
