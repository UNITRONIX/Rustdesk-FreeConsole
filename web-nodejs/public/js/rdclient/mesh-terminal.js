/**
 * MeshCentral remote terminal (relay p=1) for MeshAgent devices.
 */
(function () {
    'use strict';

    var XTERM_VERSION = '5.5.0';
    var XTERM_CSS_URL = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@' + XTERM_VERSION + '/css/xterm.min.css';
    var XTERM_JS_URL = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@' + XTERM_VERSION + '/lib/xterm.min.js';
    var XTERM_FIT_URL = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@' + XTERM_VERSION + '/lib/addon-fit.min.js';
    var CTRL = '102938';
    var PROTOCOL = '1';

    var xtermLoaded = false;
    var xtermLoading = null;
    var activeModal = null;

    function t(key, fallback) {
        if (typeof window.t === 'function') {
            var val = window.t(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    function loadXterm() {
        if (xtermLoaded) return Promise.resolve();
        if (xtermLoading) return xtermLoading;
        xtermLoading = new Promise(function (resolve, reject) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = XTERM_CSS_URL;
            document.head.appendChild(link);
            var script = document.createElement('script');
            script.src = XTERM_JS_URL;
            script.onload = function () {
                var fitScript = document.createElement('script');
                fitScript.src = XTERM_FIT_URL;
                fitScript.onload = function () { xtermLoaded = true; resolve(); };
                fitScript.onerror = function () { reject(new Error('xterm-addon-fit load failed')); };
                document.head.appendChild(fitScript);
            };
            script.onerror = function () { reject(new Error('xterm load failed')); };
            document.head.appendChild(script);
        });
        return xtermLoading;
    }

    function ctrlMsg(type, fields) {
        var o = { ctrlChannel: CTRL, type: type };
        if (fields) Object.assign(o, fields);
        return JSON.stringify(o);
    }

    function closeModal() {
        if (!activeModal) return;
        if (activeModal.ws) {
            try { activeModal.ws.close(); } catch { /* ignore */ }
        }
        if (activeModal.resizeObserver) activeModal.resizeObserver.disconnect();
        if (activeModal.term) activeModal.term.dispose();
        if (activeModal.overlay) activeModal.overlay.remove();
        activeModal = null;
    }

    async function openMeshTerminal(deviceId) {
        if (activeModal) closeModal();

        try {
            await loadXterm();
        } catch (err) {
            if (typeof Notifications !== 'undefined') {
                Notifications.error(err.message);
            }
            return;
        }

        var Terminal = window.Terminal;
        var FitAddon = window.FitAddon && window.FitAddon.FitAddon;
        if (!Terminal || !FitAddon) {
            if (typeof Notifications !== 'undefined') Notifications.error('Terminal library unavailable');
            return;
        }

        var overlay = document.createElement('div');
        overlay.className = 'mesh-terminal-overlay';
        overlay.innerHTML =
            '<div class="mesh-terminal-modal">' +
            '<div class="mesh-terminal-header">' +
            '<span class="mesh-terminal-title">' + t('mesh.terminal_title', 'Remote terminal') + ' — ' + deviceId + '</span>' +
            '<button type="button" class="mesh-terminal-close" aria-label="Close"><span class="material-icons">close</span></button>' +
            '</div>' +
            '<div class="mesh-terminal-host"></div>' +
            '</div>';
        document.body.appendChild(overlay);

        overlay.querySelector('.mesh-terminal-close').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        var host = overlay.querySelector('.mesh-terminal-host');
        var fitAddon = new FitAddon();
        var term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Consolas', monospace",
            theme: { background: '#0d1117', foreground: '#e6edf3' },
            scrollback: 5000,
        });
        term.loadAddon(fitAddon);
        term.open(host);
        term.writeln('\x1b[33mConnecting…\x1b[0m');
        try { fitAddon.fit(); } catch { /* ignore */ }

        var session = {
            overlay: overlay,
            term: term,
            fitAddon: fitAddon,
            ws: null,
            relayReady: false,
        };
        activeModal = session;

        var resizeObserver = new ResizeObserver(function () {
            try {
                fitAddon.fit();
                sendTermSize(session);
            } catch { /* ignore */ }
        });
        resizeObserver.observe(host);
        session.resizeObserver = resizeObserver;

        try {
            var relayBase = window.location.origin + '/';
            var resp = await fetch(
                '/api/mesh/devices/' + encodeURIComponent(deviceId) + '/terminal?relay_base=' + encodeURIComponent(relayBase),
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                }
            );
            if (!resp.ok) {
                var errBody = await resp.json().catch(function () { return {}; });
                throw new Error(errBody.error || 'Terminal tunnel failed');
            }
            var data = await resp.json();
            var url = data.browser_url || data.data && data.data.browser_url;
            if (!url) throw new Error('No relay URL');
            var wsUrl = url.indexOf('http') === 0 ? url.replace(/^http/, 'ws') : window.location.origin + url;
            var ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
            session.ws = ws;

            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    if (ev.data === 'c' || ev.data === 'cr') {
                        if (!session.relayReady) {
                            session.relayReady = true;
                            ws.send(PROTOCOL);
                            term.clear();
                            sendTermSize(session);
                            term.focus();
                        }
                        return;
                    }
                    try {
                        var msg = JSON.parse(ev.data);
                        if (msg.ctrlChannel === CTRL && msg.type === 'console' && msg.msg) {
                            term.writeln('\x1b[33m' + msg.msg + '\x1b[0m');
                        }
                    } catch { /* ignore */ }
                    return;
                }
                var buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data.buffer);
                term.write(buf);
            };

            ws.onerror = function () {
                term.writeln('\x1b[31mWebSocket error\x1b[0m');
            };
            ws.onclose = function () {
                term.writeln('\x1b[33mDisconnected\x1b[0m');
            };

            term.onData(function (data) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(new TextEncoder().encode(data));
                }
            });
            term.onResize(function () { sendTermSize(session); });
        } catch (err) {
            term.writeln('\x1b[31m' + err.message + '\x1b[0m');
        }
    }

    function sendTermSize(session) {
        if (!session.ws || session.ws.readyState !== WebSocket.OPEN || !session.relayReady) return;
        session.ws.send(ctrlMsg('termsize', {
            cols: session.term.cols,
            rows: session.term.rows,
        }));
    }

    window.openMeshTerminal = openMeshTerminal;
    window.closeMeshTerminal = closeModal;
})();
