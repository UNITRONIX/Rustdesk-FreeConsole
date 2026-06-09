/**
 * BetterDesk Console — CDAP Terminal Widget
 * Provides interactive terminal access to CDAP devices via WebSocket.
 * Dynamically loads xterm.js + xterm-addon-fit when a terminal widget is opened.
 */

(function () {
    'use strict';

    const XTERM_VERSION = '5.5.0';
    const XTERM_CSS_URL = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/css/xterm.min.css`;
    const XTERM_JS_URL = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/lib/xterm.min.js`;
    const XTERM_FIT_URL = `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${XTERM_VERSION}/lib/addon-fit.min.js`;

    let xtermLoaded = false;
    let xtermLoading = null;

    // ── Dynamic xterm.js Loader ──────────────────────────────────────────

    function loadXterm() {
        if (xtermLoaded) return Promise.resolve();
        if (xtermLoading) return xtermLoading;

        xtermLoading = new Promise((resolve, reject) => {
            // Load CSS
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = XTERM_CSS_URL;
            document.head.appendChild(link);

            // Load xterm core
            const script = document.createElement('script');
            script.src = XTERM_JS_URL;
            script.onload = () => {
                // Load fit addon after core
                const fitScript = document.createElement('script');
                fitScript.src = XTERM_FIT_URL;
                fitScript.onload = () => {
                    xtermLoaded = true;
                    resolve();
                };
                fitScript.onerror = () => reject(new Error('Failed to load xterm-addon-fit'));
                document.head.appendChild(fitScript);
            };
            script.onerror = () => reject(new Error('Failed to load xterm.js'));
            document.head.appendChild(script);
        });

        return xtermLoading;
    }

    // ── Terminal Session Manager ─────────────────────────────────────────

    const activeSessions = {};

    async function openTerminal(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        if (activeSessions[key]) {
            activeSessions[key].terminal.focus();
            return;
        }

        // Load xterm.js if not ready
        try {
            await loadXterm();
        } catch (err) {
            console.error('Failed to load xterm.js:', err);
            showTerminalError(widgetId, 'Failed to load terminal library');
            return;
        }

        const container = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"] .cdap-terminal`);
        if (!container) return;

        // Clear stub content
        container.innerHTML = '';

        const Terminal = window.Terminal;
        const FitAddon = window.FitAddon?.FitAddon;
        if (!Terminal || !FitAddon) {
            showTerminalError(widgetId, 'Terminal library not available');
            return;
        }

        // Create xterm instance
        const fitAddon = new FitAddon();
        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            theme: {
                background: '#0d1117',
                foreground: '#e6edf3',
                cursor: '#58a6ff',
                selectionBackground: 'rgba(88, 166, 255, 0.3)',
                black: '#484f58',
                red: '#ff7b72',
                green: '#3fb950',
                yellow: '#d29922',
                blue: '#58a6ff',
                magenta: '#bc8cff',
                cyan: '#39d353',
                white: '#b1bac4',
                brightBlack: '#6e7681',
                brightRed: '#ffa198',
                brightGreen: '#56d364',
                brightYellow: '#e3b341',
                brightBlue: '#79c0ff',
                brightMagenta: '#d2a8ff',
                brightCyan: '#56d364',
                brightWhite: '#f0f6fc'
            },
            scrollback: 5000,
            convertEol: true
        });

        term.loadAddon(fitAddon);
        term.open(container);

        // Add connecting message
        term.writeln('\x1b[33mConnecting to device...\x1b[0m');

        // Fit to container
        try {
            fitAddon.fit();
        } catch (_) { /* ignore fit errors */ }

        // Open WebSocket to Go server via Node.js proxy
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(deviceId)}/terminal`;
        let ws;
        try {
            ws = new WebSocket(wsUrl, ['cdap-terminal']);
        } catch (err) {
            term.writeln(`\x1b[31mConnection failed: ${err.message}\x1b[0m`);
            return;
        }

        const session = {
            terminal: term,
            fitAddon: fitAddon,
            ws: ws,
            widgetId: widgetId,
            sessionId: null
        };
        activeSessions[key] = session;

        ws.onopen = () => {
            // Send init message with terminal dimensions
            ws.send(JSON.stringify({
                cols: term.cols,
                rows: term.rows
            }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'ready':
                        session.sessionId = msg.session_id;
                        term.clear();
                        term.focus();
                        break;
                    case 'output':
                        term.write(msg.data || '');
                        break;
                    case 'error':
                        term.writeln(`\x1b[31m${msg.error || 'Unknown error'}\x1b[0m`);
                        break;
                    case 'end':
                        term.writeln(`\x1b[33m\r\nSession ended: ${msg.reason || 'disconnected'}\x1b[0m`);
                        closeTerminal(deviceId, widgetId);
                        break;
                }
            } catch (_) {
                // Non-JSON message, write raw
                term.write(event.data);
            }
        };

        ws.onerror = () => {
            term.writeln('\x1b[31mWebSocket error\x1b[0m');
        };

        ws.onclose = (event) => {
            if (activeSessions[key]) {
                term.writeln(`\x1b[33m\r\nDisconnected (code: ${event.code})\x1b[0m`);
                delete activeSessions[key];
            }
        };

        // Relay keyboard input to server
        term.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data: data }));
            }
        });

        // Handle resize
        term.onResize(({ cols, rows }) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });

        // Resize observer for container
        const resizeObserver = new ResizeObserver(() => {
            try {
                fitAddon.fit();
            } catch (_) { /* ignore */ }
        });
        resizeObserver.observe(container);
        session._resizeObserver = resizeObserver;
    }

    function closeTerminal(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session) return;

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'close' }));
            session.ws.close();
        }
        if (session._resizeObserver) {
            session._resizeObserver.disconnect();
        }
        session.terminal.dispose();
        delete activeSessions[key];
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function showTerminalError(widgetId, message) {
        const container = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"] .cdap-terminal-output`);
        if (container) {
            container.innerHTML = `<div class="cdap-terminal-line" style="color: #ff7b72;">${escapeHtml(message)}</div>`;
        }
    }

    // ── Public API ───────────────────────────────────────────────────────

    window.CDAPTerminal = {
        open: openTerminal,
        close: closeTerminal,
        isActive: (deviceId, widgetId) => !!activeSessions[`${deviceId}:${widgetId}`]
    };

})();
