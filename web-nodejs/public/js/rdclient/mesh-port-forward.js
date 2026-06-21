/**
 * MeshCentral TCP/UDP port relay — browser WebSocket tunnel to remote host via MeshAgent.
 */
(function () {
    'use strict';

    var active = null;

    function t(key, fallback) {
        if (typeof window.t === 'function') {
            var val = window.t(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    function closeRelay() {
        if (!active) return;
        if (active.ws) {
            try { active.ws.close(); } catch { /* ignore */ }
        }
        if (active.overlay) active.overlay.remove();
        active = null;
    }

    async function openMeshPortForward(deviceId, udp) {
        closeRelay();

        const overlay = document.createElement('div');
        overlay.className = 'mesh-terminal-overlay mesh-port-overlay';
        overlay.innerHTML =
            '<div class="mesh-terminal-modal mesh-port-modal">' +
            '<div class="mesh-terminal-header">' +
            '<span class="mesh-terminal-title">' + t('mesh.port_forward_title', 'Port relay') + ' — ' + deviceId + '</span>' +
            '<button type="button" class="mesh-terminal-close" aria-label="Close"><span class="material-icons">close</span></button>' +
            '</div>' +
            '<div class="mesh-port-body">' +
            '<div class="form-row mesh-port-connect-row">' +
            '<input type="text" class="form-input mesh-port-host" placeholder="127.0.0.1" value="127.0.0.1">' +
            '<input type="number" class="form-input mesh-port-port" placeholder="Port" min="1" max="65535" value="3389">' +
            '<button type="button" class="btn btn-primary mesh-port-connect-btn">' + t('mesh.port_connect', 'Connect') + '</button>' +
            '</div>' +
            '<div class="mesh-port-log"></div>' +
            '<div class="mesh-port-send-row">' +
            '<input type="text" class="form-input mesh-port-send-input" placeholder="' + t('mesh.port_send_placeholder', 'Send text…') + '">' +
            '<button type="button" class="btn btn-secondary mesh-port-send-btn">' + t('mesh.port_send', 'Send') + '</button>' +
            '</div>' +
            '</div></div>';
        document.body.appendChild(overlay);

        const logEl = overlay.querySelector('.mesh-port-log');
        const hostInput = overlay.querySelector('.mesh-port-host');
        const portInput = overlay.querySelector('.mesh-port-port');
        const sendInput = overlay.querySelector('.mesh-port-send-input');

        function log(line, cls) {
            const div = document.createElement('div');
            div.className = 'mesh-port-log-line' + (cls ? ' ' + cls : '');
            div.textContent = line;
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
        }

        overlay.querySelector('.mesh-terminal-close').addEventListener('click', closeRelay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeRelay();
        });

        active = { overlay: overlay, ws: null, ready: false, udp: udp };

        overlay.querySelector('.mesh-port-connect-btn').addEventListener('click', async () => {
            const host = hostInput.value.trim() || '127.0.0.1';
            const port = parseInt(portInput.value, 10);
            if (!port || port < 1 || port > 65535) {
                log(t('mesh.port_invalid', 'Invalid port'), 'error');
                return;
            }
            try {
                const path = udp ? 'udp' : 'tcp';
                const relayBase = encodeURIComponent(window.location.origin + '/');
                const resp = await fetch('/api/mesh/devices/' + encodeURIComponent(deviceId) + '/' + path + '?relay_base=' + relayBase, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ host, port }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.error || 'Tunnel failed');
                }
                const data = await resp.json();
                const url = data.browser_url || data.data && data.data.browser_url;
                if (!url) throw new Error('No relay URL');
                const wsUrl = url.indexOf('http') === 0 ? url.replace(/^http/, 'ws') : window.location.origin + url;
                const ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer';
                active.ws = ws;
                log(t('mesh.port_connecting', 'Connecting…'));

                ws.onmessage = (ev) => {
                    if (typeof ev.data === 'string') {
                        if (ev.data === 'c' || ev.data === 'cr') {
                            if (!active.ready) {
                                active.ready = true;
                                ws.send('14');
                                log(t('mesh.port_connected', 'Relay ready — binary mode'));
                            }
                            return;
                        }
                        log('[text] ' + ev.data);
                        return;
                    }
                    const buf = new Uint8Array(ev.data);
                    let text = '';
                    try {
                        text = new TextDecoder().decode(buf);
                    } catch {
                        text = '[' + buf.length + ' bytes]';
                    }
                    log('[rx] ' + text);
                };
                ws.onerror = () => log(t('mesh.port_error', 'WebSocket error'), 'error');
                ws.onclose = () => log(t('mesh.port_closed', 'Disconnected'));
            } catch (err) {
                log(err.message || String(err), 'error');
            }
        });

        overlay.querySelector('.mesh-port-send-btn').addEventListener('click', () => {
            if (!active || !active.ws || active.ws.readyState !== WebSocket.OPEN || !active.ready) return;
            const text = sendInput.value;
            if (!text) return;
            active.ws.send(new TextEncoder().encode(text));
            log('[tx] ' + text);
            sendInput.value = '';
        });
    }

    window.openMeshPortForward = openMeshPortForward;
    window.closeMeshPortForward = closeRelay;
})();
