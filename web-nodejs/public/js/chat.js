/**
 * BetterDesk Console — Chat 2.0 Client
 *
 * Features:
 *  - E2E encryption (ECDH P-256 + AES-256-GCM) via chatCrypto.js
 *  - 1:1 and group conversations
 *  - File sharing (encrypted, up to 50MB)
 *  - Typing indicator, read receipts, online presence
 *  - Message search, push notifications, emoji reactions
 *  - Quick commands (/screenshot, /restart, /lock, /deploy)
 */

'use strict';

/* global _, Utils, Toast */

(function () {
    // ==================== State ====================
    let ws = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    const MAX_RECONNECT = 60000;

    let contacts = [];
    let groups = [];
    let conversations = new Map(); // conv_id → { messages: [], unread: 0 }
    let activeConvId = null;
    let activeConvType = 'contact'; // 'contact' | 'group'
    let myPresence = 'online';
    let typingTimers = new Map(); // conv_id → timeout
    let lastTypingSent = 0;
    let pendingFile = null;
    let e2eKeys = new Map(); // conv_id → { publicKey, sharedSecret }

    // Quick commands definition
    const QUICK_COMMANDS = {
        '/screenshot': { icon: 'screenshot_monitor', label: 'Screenshot', action: 'screenshot' },
        '/restart': { icon: 'restart_alt', label: 'Restart', action: 'restart', confirm: true },
        '/lock': { icon: 'lock', label: 'Lock screen', action: 'lock' },
        '/shutdown': { icon: 'power_settings_new', label: 'Shutdown', action: 'shutdown', confirm: true },
        '/deploy': { icon: 'cloud_upload', label: 'Deploy script', action: 'deploy', hasArg: true },
        '/info': { icon: 'info', label: 'Device info', action: 'info' },
    };

    // Common emoji set (lightweight)
    const EMOJI_SET = ['👍', '👎', '❤️', '😂', '😮', '😢', '🔥', '🎉', '✅', '❌',
        '👏', '🤔', '💯', '⭐', '🚀', '🐛', '🔧', '📎', '🔒', '⚡'];

    // ==================== DOM References ====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {};

    function initDom() {
        dom.contactsList = $('#chat-contacts-list');
        dom.groupsList = $('#chat-groups-list');
        dom.emptyState = $('#chat-empty-state');
        dom.conversation = $('#chat-conversation');
        dom.convName = $('#chat-conv-name');
        dom.convStatus = $('#chat-conv-status');
        dom.convAvatar = $('#chat-conv-avatar');
        dom.messagesInner = $('#chat-messages-inner');
        dom.messagesWrap = $('#chat-messages');
        dom.input = $('#chat-input');
        dom.sendBtn = $('#chat-send-btn');
        dom.typing = $('#chat-typing');
        dom.typingText = $('#chat-typing-text');
        dom.e2eBanner = $('#chat-e2e-banner');
        dom.e2eText = $('#chat-e2e-text');
        dom.fileInput = $('#chat-file-input');
        dom.filePreview = $('#chat-file-preview');
        dom.fileName = $('#chat-file-name');
        dom.fileSize = $('#chat-file-size');
        dom.searchBar = $('#chat-search-bar');
        dom.searchInput = $('#chat-search-input');
        dom.searchResults = $('#chat-search-results');
        dom.emojiPicker = $('#chat-emoji-picker');
        dom.presenceSelect = $('#chat-presence-select');
        dom.presenceDot = $('#chat-my-presence-dot');
        dom.groupModal = $('#chat-group-modal');
        dom.groupNameInput = $('#chat-group-name-input');
        dom.memberSelect = $('#chat-member-select');
    }

    // ==================== WebSocket ====================
    function connect() {
        if (ws && ws.readyState <= WebSocket.OPEN) return;

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        // Connect as operator — deviceId = 'panel' for standalone chat
        ws = new WebSocket(`${proto}://${location.host}/ws/chat-operator/panel`);

        ws.onopen = () => {
            reconnectDelay = 2000;
            ws.send(JSON.stringify({ type: 'hello', device_id: 'panel', role: 'operator' }));
            ws.send(JSON.stringify({ type: 'get_contacts', device_id: 'panel' }));

            // Send presence
            sendPresence(myPresence);
        };

        ws.onmessage = (evt) => {
            let frame;
            try { frame = JSON.parse(evt.data); } catch { return; }
            handleFrame(frame);
        };

        ws.onclose = () => {
            scheduleReconnect();
        };

        ws.onerror = () => {};
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT);
            connect();
        }, reconnectDelay);
    }

    function send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    // ==================== Frame Handler ====================
    function handleFrame(frame) {
        switch (frame.type) {
            case 'welcome':
                updateConnectionStatus(true);
                break;

            case 'contacts':
                contacts = frame.contacts || [];
                renderContacts();
                break;

            case 'groups':
                groups = frame.groups || [];
                renderGroups();
                break;

            case 'history': {
                const convId = frame.conversation_id || 'default';
                if (!conversations.has(convId)) {
                    conversations.set(convId, { messages: [], unread: 0 });
                }
                const conv = conversations.get(convId);
                conv.messages = (frame.messages || []).map(normalizeMessage);
                if (convId === activeConvId) renderMessages();
                break;
            }

            case 'message': {
                const msg = normalizeMessage(frame);
                const convId = msg.conversation_id || 'default';
                if (!conversations.has(convId)) {
                    conversations.set(convId, { messages: [], unread: 0 });
                }
                const conv = conversations.get(convId);
                conv.messages.push(msg);
                if (conv.messages.length > 1000) conv.messages.splice(0, conv.messages.length - 1000);

                if (convId === activeConvId) {
                    appendMessageDom(msg);
                    scrollToBottom();
                    // Auto send read receipt
                    send({ type: 'read_receipt', conversation_id: convId, message_ids: [msg.id] });
                } else {
                    conv.unread++;
                    updateUnreadBadge(convId, conv.unread);
                    showNotification(msg);
                }
                break;
            }

            case 'typing': {
                const convId = frame.conversation_id || 'default';
                if (convId !== activeConvId) return;
                const name = frame.from_name || frame.from || frame.operator || '';
                showTyping(name);
                break;
            }

            case 'read_receipt':
                if (frame.conversation_id === activeConvId) {
                    markMessagesRead(frame.message_ids || []);
                }
                break;

            case 'presence': {
                const deviceId = frame.device_id;
                const c = contacts.find(c => c.id === deviceId);
                if (c) {
                    c.online = frame.online;
                    c.status = frame.status || (frame.online ? 'online' : 'offline');
                    renderContacts();
                    if (activeConvId === deviceId) updateConvHeader();
                }
                break;
            }

            case 'key_exchange':
                handleKeyExchange(frame);
                break;

            case 'file_share':
                handleFileShare(frame);
                break;

            case 'status':
                updateConnectionStatus(true);
                break;

            case 'system_message': {
                const sysMsg = {
                    id: frame.id || Date.now(),
                    from: 'system',
                    text: frame.text || '',
                    timestamp: frame.timestamp || Date.now(),
                    system: true,
                    conversation_id: frame.conversation_id || activeConvId || 'default',
                };
                const convId = sysMsg.conversation_id;
                if (!conversations.has(convId)) conversations.set(convId, { messages: [], unread: 0 });
                conversations.get(convId).messages.push(sysMsg);
                if (convId === activeConvId) {
                    appendMessageDom(sysMsg);
                    scrollToBottom();
                }
                break;
            }

            case 'reaction': {
                const convId = frame.conversation_id;
                if (convId !== activeConvId) return;
                const msgEl = document.querySelector(`.chat-msg[data-id="${frame.message_id}"]`);
                if (msgEl) addReactionBadge(msgEl, frame.emoji, frame.from);
                break;
            }

            case 'command_result': {
                const text = `Command result (${frame.action}): ${frame.result || frame.error || 'done'}`;
                const sysMsg = { id: Date.now(), from: 'system', text, timestamp: Date.now(), system: true, conversation_id: frame.conversation_id || activeConvId };
                if (sysMsg.conversation_id && conversations.has(sysMsg.conversation_id)) {
                    conversations.get(sysMsg.conversation_id).messages.push(sysMsg);
                    if (sysMsg.conversation_id === activeConvId) {
                        appendMessageDom(sysMsg);
                        scrollToBottom();
                    }
                }
                break;
            }
        }
    }

    // ==================== Key Exchange (E2E) ====================
    async function initE2E(convId) {
        if (typeof ChatCrypto === 'undefined') return;
        try {
            await ChatCrypto.init(convId);
            const pubKey = await ChatCrypto.getPublicKey();
            send({ type: 'key_exchange', conversation_id: convId, public_key: pubKey });
            showE2EBanner('establishing');
        } catch (e) {
            console.warn('[Chat] E2E init failed:', e.message);
        }
    }

    async function handleKeyExchange(frame) {
        if (typeof ChatCrypto === 'undefined') return;
        try {
            await ChatCrypto.receivePublicKey(frame.conversation_id || activeConvId, frame.public_key);
            showE2EBanner('established');
        } catch (e) {
            console.warn('[Chat] Key exchange failed:', e.message);
        }
    }

    function showE2EBanner(state) {
        if (!dom.e2eBanner) return;
        dom.e2eBanner.style.display = 'flex';
        if (state === 'established') {
            dom.e2eText.textContent = _('chat.e2e_established');
            dom.e2eBanner.classList.add('established');
            setTimeout(() => { dom.e2eBanner.style.display = 'none'; }, 5000);
        } else {
            dom.e2eText.textContent = _('chat.e2e_establishing');
            dom.e2eBanner.classList.remove('established');
        }
    }

    // ==================== Contacts & Groups ====================
    function renderContacts() {
        if (!dom.contactsList) return;
        if (contacts.length === 0) {
            dom.contactsList.innerHTML = `<div class="chat-list-empty"><span class="material-icons">forum</span><p>${_('chat.no_contacts')}</p></div>`;
            return;
        }

        // Sort: online first, then alphabetical
        const sorted = [...contacts].sort((a, b) => {
            if (a.online && !b.online) return -1;
            if (!a.online && b.online) return 1;
            return (a.name || a.id).localeCompare(b.name || b.id);
        });

        dom.contactsList.innerHTML = sorted.map(c => {
            const conv = conversations.get(c.id);
            const unread = conv ? conv.unread : 0;
            const name = Utils.escapeHtml(c.name || c.id);
            const presenceClass = c.online ? (c.status || 'online') : 'offline';
            const initial = (c.name || c.id).charAt(0).toUpperCase();
            const color = Utils.sanitizeColor(c.avatar_color || '#4f6ef7');
            const roleClass = c.role ? String(c.role).replace(/[^a-z0-9_-]/gi, '') : '';
            const roleLabel = c.role ? Utils.escapeHtml(c.role) : '';
            const lastMsg = conv && conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : null;
            const preview = lastMsg ? Utils.escapeHtml(lastMsg.text || '').slice(0, 40) : '';

            return `
                <div class="chat-list-item ${activeConvId === c.id ? 'active' : ''}" data-id="${Utils.escapeHtml(c.id)}" data-type="contact">
                    <div class="chat-avatar" style="background-color: ${color}">
                        ${initial}
                        <span class="chat-presence-indicator ${presenceClass}"></span>
                    </div>
                    <div class="chat-list-item-body">
                        <div class="chat-list-item-header">
                            <span class="chat-list-name">${name}</span>
                            ${lastMsg ? `<span class="chat-list-time">${formatTime(lastMsg.timestamp)}</span>` : ''}
                        </div>
                        <div class="chat-list-preview">
                            ${roleLabel ? `<span class="chat-role-badge ${roleClass}">${roleLabel}</span>` : ''}
                            ${preview}
                        </div>
                    </div>
                    ${unread > 0 ? `<span class="chat-unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
                </div>
            `;
        }).join('');

        // Attach click handlers
        dom.contactsList.querySelectorAll('.chat-list-item').forEach(el => {
            el.addEventListener('click', () => openConversation(el.dataset.id, 'contact'));
        });
    }

    function renderGroups() {
        if (!dom.groupsList) return;
        if (groups.length === 0) {
            dom.groupsList.innerHTML = `<div class="chat-list-empty"><span class="material-icons">group</span><p>${_('chat.no_groups')}</p></div>`;
            return;
        }

        dom.groupsList.innerHTML = groups.map(g => {
            const conv = conversations.get(`group_${g.id}`);
            const unread = conv ? conv.unread : 0;
            const name = Utils.escapeHtml(g.name);

            return `
                <div class="chat-list-item ${activeConvId === 'group_' + g.id ? 'active' : ''}" data-id="group_${Utils.escapeHtml(g.id)}" data-type="group">
                    <div class="chat-avatar group-avatar">
                        <span class="material-icons">groups</span>
                    </div>
                    <div class="chat-list-item-body">
                        <span class="chat-list-name">${name}</span>
                        <span class="chat-list-members">${(g.members || []).length} ${_('chat.members')}</span>
                    </div>
                    ${unread > 0 ? `<span class="chat-unread-badge">${unread}</span>` : ''}
                </div>
            `;
        }).join('');

        dom.groupsList.querySelectorAll('.chat-list-item').forEach(el => {
            el.addEventListener('click', () => openConversation(el.dataset.id, 'group'));
        });
    }

    // ==================== Conversation ====================
    function openConversation(convId, type) {
        activeConvId = convId;
        activeConvType = type || 'contact';

        // Create conversation if needed
        if (!conversations.has(convId)) {
            conversations.set(convId, { messages: [], unread: 0 });
        }

        // Clear unread
        const conv = conversations.get(convId);
        conv.unread = 0;
        updateUnreadBadge(convId, 0);

        // Update UI
        dom.emptyState.style.display = 'none';
        dom.conversation.style.display = 'flex';

        updateConvHeader();
        renderMessages();
        scrollToBottom();

        // Mark active in list
        $$('.chat-list-item').forEach(el => el.classList.toggle('active', el.dataset.id === convId));

        // Load history from server
        send({ type: 'get_history', device_id: 'panel', conversation_id: convId });

        // Init E2E for this conversation
        initE2E(convId);

        // Focus input
        if (dom.input) dom.input.focus();
    }

    function updateConvHeader() {
        if (!activeConvId) return;

        if (activeConvType === 'group') {
            const g = groups.find(g => 'group_' + g.id === activeConvId);
            if (g) {
                dom.convName.textContent = g.name;
                dom.convStatus.textContent = `${(g.members || []).length} ${_('chat.members')}`;
                dom.convAvatar.innerHTML = '<span class="material-icons">groups</span>';
                dom.convAvatar.className = 'chat-conv-avatar group-avatar';
            }
        } else {
            const c = contacts.find(c => c.id === activeConvId);
            if (c) {
                const name = c.name || c.id;
                dom.convName.textContent = name;
                const presenceKey = c.online ? (c.status || 'online') : 'offline';
                dom.convStatus.textContent = _(`chat.presence_${presenceKey}`);
                dom.convStatus.className = `chat-conv-status presence-${presenceKey}`;
                dom.convAvatar.textContent = name.charAt(0).toUpperCase();
                dom.convAvatar.style.backgroundColor = c.avatar_color || '#4f6ef7';
                dom.convAvatar.className = 'chat-conv-avatar';
            }
        }
    }

    // ==================== Messages ====================
    function normalizeMessage(msg) {
        return {
            id: msg.id || Date.now(),
            from: msg.from || '',
            from_name: msg.from_name || msg.operator || msg.from || '',
            text: msg.text || '',
            timestamp: msg.timestamp || Date.now(),
            conversation_id: msg.conversation_id || '',
            system: !!msg.system,
            file: msg.file || null,
            reactions: msg.reactions || {},
            read_by: msg.read_by || [],
        };
    }

    function renderMessages() {
        if (!dom.messagesInner) return;
        const conv = conversations.get(activeConvId);
        if (!conv || conv.messages.length === 0) {
            dom.messagesInner.innerHTML = `<div class="chat-messages-empty"><p>${_('chat.no_messages')}</p></div>`;
            return;
        }

        let html = '';
        let lastDate = '';

        for (const msg of conv.messages) {
            // Date separator
            const date = formatDate(msg.timestamp);
            if (date !== lastDate) {
                html += `<div class="chat-date-separator"><span>${date}</span></div>`;
                lastDate = date;
            }
            html += renderMessageHtml(msg);
        }

        dom.messagesInner.innerHTML = html;
        attachMessageHandlers();
        scrollToBottom();
    }

    function renderMessageHtml(msg) {
        const msgId = Utils.escapeHtml(String(msg.id ?? ''));

        if (msg.system) {
            return `<div class="chat-msg system" data-id="${msgId}">
                <span class="material-icons">info</span>
                <span>${Utils.escapeHtml(msg.text)}</span>
            </div>`;
        }

        const isMe = msg.from === 'operator' || msg.from === 'panel';
        const name = Utils.escapeHtml(msg.from_name || msg.from);
        const time = formatTime(msg.timestamp);
        const readIcon = msg.read_by && msg.read_by.length > 0 ? 'done_all' : 'done';

        let content = '';
        if (msg.file) {
            content = `<div class="chat-file-msg">
                <span class="material-icons">description</span>
                <a href="${Utils.escapeHtml(msg.file.url)}" target="_blank" rel="noopener">${Utils.escapeHtml(msg.file.name)}</a>
                <span class="chat-file-size-label">${formatFileSize(msg.file.size)}</span>
            </div>`;
        }
        content += msg.text ? `<div class="chat-msg-text">${linkify(Utils.escapeHtml(msg.text))}</div>` : '';

        // Reactions
        let reactionsHtml = '';
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
            reactionsHtml = '<div class="chat-reactions">';
            for (const [emoji, users] of Object.entries(msg.reactions)) {
                const safeEmoji = Utils.escapeHtml(emoji);
                const safeTitle = Utils.escapeHtml((users || []).join(', '));
                reactionsHtml += `<span class="chat-reaction" data-emoji="${safeEmoji}" title="${safeTitle}">${safeEmoji} ${users.length}</span>`;
            }
            reactionsHtml += '</div>';
        }

        return `
            <div class="chat-msg ${isMe ? 'mine' : 'theirs'}" data-id="${msgId}">
                ${!isMe ? `<div class="chat-msg-sender">${name}</div>` : ''}
                <div class="chat-msg-bubble">
                    ${content}
                    <div class="chat-msg-meta">
                        <span class="chat-msg-time">${time}</span>
                        ${isMe ? `<span class="material-icons chat-msg-read">${readIcon}</span>` : ''}
                    </div>
                    <button class="chat-msg-react-btn" title="${_('chat.react')}">
                        <span class="material-icons">add_reaction</span>
                    </button>
                </div>
                ${reactionsHtml}
            </div>
        `;
    }

    function appendMessageDom(msg) {
        if (!dom.messagesInner) return;
        // Remove empty state
        const empty = dom.messagesInner.querySelector('.chat-messages-empty');
        if (empty) empty.remove();

        const html = renderMessageHtml(msg);
        dom.messagesInner.insertAdjacentHTML('beforeend', html);

        // Attach handlers to new message
        const lastMsg = dom.messagesInner.lastElementChild;
        if (lastMsg) attachSingleMessageHandlers(lastMsg);
    }

    function attachMessageHandlers() {
        dom.messagesInner.querySelectorAll('.chat-msg').forEach(el => attachSingleMessageHandlers(el));
    }

    function attachSingleMessageHandlers(el) {
        const reactBtn = el.querySelector('.chat-msg-react-btn');
        if (reactBtn) {
            reactBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showReactionPicker(el, e.currentTarget);
            });
        }
        el.querySelectorAll('.chat-reaction').forEach(badge => {
            badge.addEventListener('click', () => {
                const emoji = badge.dataset.emoji;
                const msgId = el.dataset.id;
                toggleReaction(msgId, emoji);
            });
        });
    }

    function scrollToBottom() {
        if (dom.messagesWrap) {
            requestAnimationFrame(() => {
                dom.messagesWrap.scrollTop = dom.messagesWrap.scrollHeight;
            });
        }
    }

    function markMessagesRead(ids) {
        ids.forEach(id => {
            const el = document.querySelector(`.chat-msg[data-id="${id}"] .chat-msg-read`);
            if (el) el.textContent = 'done_all';
        });
    }

    // ==================== Sending ====================
    function sendMessage() {
        const text = (dom.input.value || '').trim();
        if (!text && !pendingFile) return;

        // Check for quick commands
        if (text.startsWith('/')) {
            const handled = handleQuickCommand(text);
            if (handled) {
                dom.input.value = '';
                autoResizeInput();
                return;
            }
        }

        // Build message
        const msg = {
            type: 'message',
            text: text,
            conversation_id: activeConvId,
            timestamp: Date.now(),
        };

        // If file is pending, upload first
        if (pendingFile) {
            uploadAndSendFile(pendingFile, text);
            pendingFile = null;
            dom.filePreview.style.display = 'none';
            dom.input.value = '';
            autoResizeInput();
            return;
        }

        send(msg);
        dom.input.value = '';
        autoResizeInput();
    }

    async function uploadAndSendFile(file, caption) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            const resp = await fetch('/api/chat/upload', {
                method: 'POST',
                body: formData,
                headers: { 'X-CSRF-Token': (typeof BetterDesk !== 'undefined' && BetterDesk.csrfToken) || '' },
            });
            const data = await resp.json();
            if (!data.success) throw new Error(data.error);

            // Send file_share frame
            send({
                type: 'file_share',
                conversation_id: activeConvId,
                file_id: data.file_id,
                file_name_encrypted: file.name,
                file_size: file.size,
                file_url: data.url,
            });

            // Send caption as message
            if (caption) {
                send({
                    type: 'message',
                    text: caption,
                    conversation_id: activeConvId,
                    timestamp: Date.now(),
                });
            }

            if (typeof Notifications !== 'undefined') Notifications.success(file.name, _('chat.file_share'));
        } catch (e) {
            if (typeof Notifications !== 'undefined') Notifications.error(e.message);
        }
    }

    // ==================== Typing ====================
    function sendTyping() {
        const now = Date.now();
        if (now - lastTypingSent < 2000) return;
        lastTypingSent = now;
        send({ type: 'typing', conversation_id: activeConvId });
    }

    function showTyping(name) {
        if (!dom.typing) return;
        dom.typingText.textContent = `${name} ${_('chat.typing_indicator')}`;
        dom.typing.style.display = 'flex';

        // Clear after 3s
        const key = activeConvId || 'default';
        if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));
        typingTimers.set(key, setTimeout(() => {
            dom.typing.style.display = 'none';
        }, 3000));
    }

    // ==================== Quick Commands ====================
    function handleQuickCommand(text) {
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const def = QUICK_COMMANDS[cmd];
        if (!def) return false;

        if (def.confirm) {
            if (!confirm(`Execute command: ${def.label} on ${activeConvId}?`)) return true;
        }

        send({
            type: 'quick_command',
            conversation_id: activeConvId,
            device_id: activeConvId,
            action: def.action,
            args: parts.slice(1).join(' '),
        });

        // Show system message locally
        const sysMsg = {
            id: Date.now(), from: 'system', system: true,
            text: `Command sent: ${cmd} ${parts.slice(1).join(' ')}`,
            timestamp: Date.now(), conversation_id: activeConvId,
        };
        const conv = conversations.get(activeConvId);
        if (conv) {
            conv.messages.push(sysMsg);
            appendMessageDom(sysMsg);
            scrollToBottom();
        }

        return true;
    }

    // ==================== Reactions ====================
    function showReactionPicker(msgEl, anchorEl) {
        if (!dom.emojiPicker) return;
        dom.emojiPicker.innerHTML = EMOJI_SET.map(e =>
            `<button class="emoji-btn" data-emoji="${e}">${e}</button>`
        ).join('');
        dom.emojiPicker.style.display = 'flex';

        // Position near the message
        const rect = anchorEl.getBoundingClientRect();
        dom.emojiPicker.style.top = (rect.top - 50) + 'px';
        dom.emojiPicker.style.left = rect.left + 'px';

        dom.emojiPicker.querySelectorAll('.emoji-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                toggleReaction(msgEl.dataset.id, btn.dataset.emoji);
                dom.emojiPicker.style.display = 'none';
            });
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closePicker() {
                dom.emojiPicker.style.display = 'none';
                document.removeEventListener('click', closePicker);
            }, { once: true });
        }, 10);
    }

    function toggleReaction(messageId, emoji) {
        send({
            type: 'reaction',
            conversation_id: activeConvId,
            message_id: messageId,
            emoji: emoji,
        });
    }

    function addReactionBadge(msgEl, emoji, from) {
        let reactionsDiv = msgEl.querySelector('.chat-reactions');
        if (!reactionsDiv) {
            reactionsDiv = document.createElement('div');
            reactionsDiv.className = 'chat-reactions';
            msgEl.appendChild(reactionsDiv);
        }

        let badge = reactionsDiv.querySelector(`[data-emoji="${emoji}"]`);
        if (badge) {
            const count = parseInt(badge.textContent.replace(emoji, '').trim()) || 1;
            badge.textContent = `${emoji} ${count + 1}`;
        } else {
            badge = document.createElement('span');
            badge.className = 'chat-reaction';
            badge.dataset.emoji = emoji;
            badge.textContent = `${emoji} 1`;
            badge.addEventListener('click', () => toggleReaction(msgEl.dataset.id, emoji));
            reactionsDiv.appendChild(badge);
        }
    }

    // ==================== File Sharing ====================
    function handleFileShare(frame) {
        const convId = frame.conversation_id || activeConvId || 'default';
        if (!conversations.has(convId)) conversations.set(convId, { messages: [], unread: 0 });

        const msg = {
            id: frame.file_id || Date.now(),
            from: frame.from,
            from_name: frame.from_name || frame.from,
            text: '',
            timestamp: frame.timestamp || Date.now(),
            conversation_id: convId,
            file: {
                id: frame.file_id,
                name: frame.file_name_encrypted || 'file',
                size: frame.file_size || 0,
                url: frame.file_url || `/api/chat/files/${frame.file_id}`,
            },
        };

        conversations.get(convId).messages.push(msg);
        if (convId === activeConvId) {
            appendMessageDom(msg);
            scrollToBottom();
        }
    }

    // ==================== Search ====================
    let searchDebounce = null;

    async function searchMessages(query) {
        if (!query || query.length < 2) {
            dom.searchResults.style.display = 'none';
            return;
        }
        try {
            const resp = await fetch(`/api/chat/search?q=${encodeURIComponent(query)}&conversation_id=${encodeURIComponent(activeConvId || '')}`);
            const data = await resp.json();
            const msgs = data.messages || [];

            dom.searchResults.style.display = 'block';
            if (msgs.length === 0) {
                dom.searchResults.innerHTML = `<div class="chat-search-no-results">${_('chat.no_results')}</div>`;
                return;
            }

            dom.searchResults.innerHTML = msgs.map(m => `
                <div class="chat-search-result" data-conv="${Utils.escapeHtml(m.conversation_id)}" data-id="${Utils.escapeHtml(String(m.id ?? ''))}">
                    <span class="chat-search-from">${Utils.escapeHtml(m.from_name || m.from_id)}</span>
                    <span class="chat-search-text">${Utils.escapeHtml((m.text || '').slice(0, 80))}</span>
                    <span class="chat-search-time">${formatTime(m.created_at || m.timestamp)}</span>
                </div>
            `).join('');

            dom.searchResults.querySelectorAll('.chat-search-result').forEach(el => {
                el.addEventListener('click', () => {
                    openConversation(el.dataset.conv, 'contact');
                    dom.searchResults.style.display = 'none';
                    dom.searchBar.style.display = 'none';
                });
            });
        } catch (e) {
            console.warn('[Chat] Search failed:', e);
        }
    }

    // ==================== Push Notifications ====================
    function showNotification(msg) {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            Notification.requestPermission();
            return;
        }
        if (Notification.permission !== 'granted') return;
        if (document.hasFocus()) return; // Don't notify if page is focused

        const name = msg.from_name || msg.from || 'Unknown';
        const body = msg.text ? msg.text.slice(0, 100) : _('chat.file_share');

        const notification = new Notification(`${name} — ${_('chat.new_message')}`, {
            body,
            icon: '/branding/favicon.svg',
            tag: `chat-${msg.conversation_id}`,
            requireInteraction: false,
        });

        notification.onclick = () => {
            window.focus();
            openConversation(msg.conversation_id, 'contact');
            notification.close();
        };

        setTimeout(() => notification.close(), 8000);
    }

    // ==================== Presence ====================
    function sendPresence(status) {
        myPresence = status;
        send({ type: 'presence_update', online: status !== 'offline', status: status });
        if (dom.presenceDot) {
            dom.presenceDot.className = `chat-presence-dot presence-${status}`;
        }
    }

    // ==================== Group Creation ====================
    function showCreateGroupModal() {
        dom.groupModal.style.display = 'flex';
        dom.groupNameInput.value = '';

        // Populate member checkboxes
        dom.memberSelect.innerHTML = contacts.map(c => `
            <label class="chat-member-option">
                <input type="checkbox" value="${Utils.escapeHtml(c.id)}">
                <span>${Utils.escapeHtml(c.name || c.id)}</span>
            </label>
        `).join('');

        dom.groupNameInput.focus();
    }

    function createGroup() {
        const name = (dom.groupNameInput.value || '').trim();
        if (!name) return;

        const memberIds = [];
        dom.memberSelect.querySelectorAll('input:checked').forEach(cb => memberIds.push(cb.value));
        if (memberIds.length === 0) return;

        send({ type: 'create_group', name, member_ids: memberIds });
        dom.groupModal.style.display = 'none';
    }

    // ==================== Helpers ====================
    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDate(ts) {
        if (!ts) return '';
        const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
        const today = new Date();
        if (d.toDateString() === today.toDateString()) return _('chat.today') || 'Today';
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return _('chat.yesterday') || 'Yesterday';
        return d.toLocaleDateString();
    }

    function formatFileSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function linkify(text) {
        return text.replace(/(https?:\/\/[^\s<>"']+)/gi, (rawUrl) => {
            try {
                const parsed = new URL(rawUrl);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return Utils.escapeHtml(rawUrl);
                }
                const safeHref = Utils.escapeHtml(parsed.href);
                const safeLabel = Utils.escapeHtml(rawUrl);
                return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
            } catch (_) {
                return Utils.escapeHtml(rawUrl);
            }
        });
    }

    function updateUnreadBadge(convId, count) {
        const el = document.querySelector(`.chat-list-item[data-id="${convId}"] .chat-unread-badge`);
        if (el) {
            if (count > 0) {
                el.textContent = count > 99 ? '99+' : count;
                el.style.display = '';
            } else {
                el.style.display = 'none';
            }
        }
        renderContacts();
        renderGroups();
    }

    function updateConnectionStatus(connected) {
        // Could add a status indicator to the header
    }

    function autoResizeInput() {
        if (!dom.input) return;
        dom.input.style.height = 'auto';
        dom.input.style.height = Math.min(dom.input.scrollHeight, 120) + 'px';
    }

    // ==================== Event Binding ====================
    function bindEvents() {
        // Send message
        dom.sendBtn.addEventListener('click', sendMessage);
        dom.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            } else {
                sendTyping();
            }
        });
        dom.input.addEventListener('input', autoResizeInput);

        // Tab switching
        $$('.chat-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                $$('.chat-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const target = tab.dataset.tab;
                $$('[data-tab-content]').forEach(panel => {
                    panel.style.display = panel.dataset.tabContent === target ? '' : 'none';
                });
            });
        });

        // Back button (mobile)
        $('#chat-back-btn').addEventListener('click', () => {
            dom.conversation.style.display = 'none';
            dom.emptyState.style.display = 'flex';
            activeConvId = null;
        });

        // Search toggle
        $('#chat-search-toggle').addEventListener('click', () => {
            const visible = dom.searchBar.style.display !== 'none';
            dom.searchBar.style.display = visible ? 'none' : 'flex';
            dom.searchResults.style.display = 'none';
            if (!visible) dom.searchInput.focus();
        });
        $('#chat-search-close').addEventListener('click', () => {
            dom.searchBar.style.display = 'none';
            dom.searchResults.style.display = 'none';
            dom.searchInput.value = '';
        });
        dom.searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => searchMessages(dom.searchInput.value), 300);
        });

        // File attach
        $('#chat-attach-btn').addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', () => {
            const file = dom.fileInput.files[0];
            if (!file) return;
            if (file.size > 50 * 1024 * 1024) {
                if (typeof Notifications !== 'undefined') Notifications.error(_('chat.file_too_large'));
                return;
            }
            pendingFile = file;
            dom.fileName.textContent = file.name;
            dom.fileSize.textContent = formatFileSize(file.size);
            dom.filePreview.style.display = 'flex';
        });
        $('#chat-file-remove').addEventListener('click', () => {
            pendingFile = null;
            dom.filePreview.style.display = 'none';
            dom.fileInput.value = '';
        });

        // Emoji picker
        $('#chat-emoji-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (dom.emojiPicker.style.display === 'flex') {
                dom.emojiPicker.style.display = 'none';
                return;
            }
            dom.emojiPicker.innerHTML = EMOJI_SET.map(emoji =>
                `<button class="emoji-btn" data-emoji="${emoji}">${emoji}</button>`
            ).join('');
            dom.emojiPicker.style.display = 'flex';

            // Position above emoji button
            const rect = e.currentTarget.getBoundingClientRect();
            dom.emojiPicker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
            dom.emojiPicker.style.left = rect.left + 'px';

            dom.emojiPicker.querySelectorAll('.emoji-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    dom.input.value += btn.dataset.emoji;
                    dom.emojiPicker.style.display = 'none';
                    dom.input.focus();
                });
            });
        });

        // Presence selector
        dom.presenceSelect.addEventListener('change', () => {
            sendPresence(dom.presenceSelect.value);
        });

        // New group
        $('#chat-new-group-btn').addEventListener('click', showCreateGroupModal);
        $('#chat-group-modal-close').addEventListener('click', () => dom.groupModal.style.display = 'none');
        $('#chat-group-cancel').addEventListener('click', () => dom.groupModal.style.display = 'none');
        $('#chat-group-create').addEventListener('click', createGroup);

        // Request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // ==================== Init ====================
    function init() {
        initDom();
        bindEvents();
        connect();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
