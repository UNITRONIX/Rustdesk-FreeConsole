/**
 * Navbar notification center.
 *
 * Responsibilities:
 *  - Fetches recent notifications from /api/bd/notifications on load
 *  - Subscribes to the shared authenticated panel event stream
 *  - Renders a dropdown list of recent items with action/link
 *  - Marks items as read via POST /api/bd/notifications/:id/read
 *  - Updates badge counter
 *
 * Defense in depth:
 *  - All server-provided text is inserted via textContent (never innerHTML) to
 *    prevent stored-XSS from compromised agent names or help request bodies.
 *  - CSRF token is sent with mutation requests (read / mark-all).
 */
(function () {
    'use strict';

    const MAX_ITEMS = 10;
    const state = {
        items: [],
        unreadCount: 0,
    };

    let dom = null;

    function _(key) {
        try {
            return (window.BetterDesk && window._) ? window._(key) : key;
        } catch {
            return key;
        }
    }

    function csrf() {
        return (window.BetterDesk && window.BetterDesk.csrfToken) || '';
    }

    function formatTime(iso) {
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return '';
            const diff = Date.now() - d.getTime();
            if (diff < 60_000) return _('notifications.just_now');
            if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
            if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
            return d.toLocaleDateString();
        } catch {
            return '';
        }
    }

    function updateBadge() {
        if (!dom) return;
        const count = state.unreadCount;
        if (count > 0) {
            dom.badge.textContent = count > 99 ? '99+' : String(count);
            dom.badge.hidden = false;
        } else {
            dom.badge.hidden = true;
        }
    }

    function renderList() {
        if (!dom) return;
        dom.list.textContent = '';

        if (state.items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'notif-empty';
            empty.textContent = _('notifications.empty');
            dom.list.appendChild(empty);
            return;
        }

        for (const item of state.items.slice(0, MAX_ITEMS)) {
            const row = document.createElement('a');
            row.className = 'notif-item' + (item.read ? '' : ' notif-unread');
            row.href = item.link || '/help-requests';
            row.dataset.id = String(item.id);

            const icon = document.createElement('span');
            icon.className = 'material-icons notif-item-icon';
            icon.textContent = item.icon || 'support_agent';

            const body = document.createElement('div');
            body.className = 'notif-item-body';

            const title = document.createElement('div');
            title.className = 'notif-item-title';
            title.textContent = item.title || _('notifications.help_request');

            const sub = document.createElement('div');
            sub.className = 'notif-item-sub';
            sub.textContent = item.message || '';

            const time = document.createElement('div');
            time.className = 'notif-item-time';
            time.textContent = formatTime(item.created_at);

            body.appendChild(title);
            body.appendChild(sub);
            body.appendChild(time);

            row.appendChild(icon);
            row.appendChild(body);

            row.addEventListener('click', () => {
                if (!item.read) {
                    markRead(item.id).catch(() => { /* best effort */ });
                }
            });

            dom.list.appendChild(row);
        }
    }

    async function fetchNotifications() {
        try {
            const resp = await fetch('/api/bd/notifications?limit=' + MAX_ITEMS, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            if (!resp.ok) return;
            const data = await resp.json();
            const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
            state.items = items;
            const serverUnreadCount = Number(data.unread_count);
            state.unreadCount = Number.isFinite(serverUnreadCount) && serverUnreadCount >= 0
                ? serverUnreadCount
                : items.filter(i => !i.read).length;
            updateBadge();
            renderList();
        } catch {
            // Silent — dropdown stays empty, badge stays hidden.
        }
    }

    async function markRead(id) {
        if (!id) return;
        try {
            await fetch('/api/bd/notifications/' + encodeURIComponent(id) + '/read', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf(),
                },
            });
            const item = state.items.find(i => String(i.id) === String(id));
            if (item && !item.read) {
                item.read = true;
                state.unreadCount = Math.max(0, state.unreadCount - 1);
                updateBadge();
                renderList();
            }
        } catch {
            // Silent; user can retry.
        }
    }

    async function markAllRead() {
        try {
            await fetch('/api/bd/notifications/read-all', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf(),
                },
            });
            state.items = state.items.map(i => ({ ...i, read: true }));
            state.unreadCount = 0;
            updateBadge();
            renderList();
        } catch {
            // Silent.
        }
    }

    function onHelpRequestEvent(payload) {
        try {
            const item = {
                id: payload.id || Date.now(),
                title: payload.device_name || _('notifications.help_request'),
                message: payload.description || payload.message || '',
                icon: 'support_agent',
                link: '/help-requests',
                read: false,
                created_at: payload.timestamp || new Date().toISOString(),
            };
            // Insert at top, cap list.
            const existingIndex = state.items.findIndex((entry) => String(entry.id) === String(item.id));
            if (existingIndex >= 0) {
                state.items.splice(existingIndex, 1);
            } else {
                state.unreadCount += 1;
            }
            state.items.unshift(item);
            if (state.items.length > MAX_ITEMS) {
                state.items = state.items.slice(0, MAX_ITEMS);
            }
            updateBadge();
            renderList();

            // Subtle badge pulse for real-time feedback.
            if (dom && dom.btn) {
                dom.btn.classList.remove('notif-pulse');
                // Force reflow so the class re-application restarts the animation.
                void dom.btn.offsetWidth;
                dom.btn.classList.add('notif-pulse');
            }
        } catch {
            // Ignore malformed payloads.
        }
    }

    function attachPanelEvents() {
        window.addEventListener('betterdesk:panel-event', (event) => {
            const payload = event.detail || {};
            if (payload.type === 'help_request') {
                onHelpRequestEvent(payload);
            } else if (payload.type === 'registration_pending' ||
                payload.type === 'registration_changed') {
                // The API is the source of truth for read state and the
                // aggregate count; reload it instead of guessing locally.
                fetchNotifications();
            }
        });
    }

    function toggleDropdown(open) {
        if (!dom) return;
        const isOpen = open !== undefined ? open : dom.dropdown.hidden;
        dom.dropdown.hidden = !isOpen;
        dom.btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
            fetchNotifications();
        }
    }

    function init() {
        dom = {
            wrapper: document.querySelector('.notif-wrapper'),
            btn: document.getElementById('notif-btn'),
            badge: document.getElementById('notif-badge'),
            dropdown: document.getElementById('notif-dropdown'),
            list: document.getElementById('notif-list'),
            markAll: document.getElementById('notif-mark-all'),
        };
        if (!dom.btn || !dom.dropdown || !dom.list) {
            dom = null;
            return;
        }

        dom.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDropdown();
        });

        if (dom.markAll) {
            dom.markAll.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                markAllRead();
            });
        }

        document.addEventListener('click', (e) => {
            if (!dom.wrapper.contains(e.target)) {
                toggleDropdown(false);
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') toggleDropdown(false);
        });

        fetchNotifications();
        attachPanelEvents();

        // Polling fallback: survives a disconnected panel event stream.
        setInterval(fetchNotifications, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
