/**
 * BetterDesk Console — Server Management Terminal WS proxy (BETA)
 *
 * Provides a WebSocket-backed PTY for the Server Management page. Connects
 * the browser xterm.js client to a real shell on the host running the Node
 * console process (e.g. for Cockpit-like server administration).
 *
 *   Browser  ←WS→  Node.js (:5000) /ws/server-management/terminal
 *
 * Implementation:
 *   • Prefers `node-pty` when available (full PTY semantics, sudo prompts work).
 *   • Falls back to `child_process.spawn(<shell>, ['-i'])` with pipes — adequate
 *     for non-interactive commands but lacks TTY semantics.
 *
 * SECURITY:
 *   • Authentication via session cookie (express-session).
 *   • Authorization: only `super_admin` and `server_admin` may open a session.
 *   • The shell runs as the user that owns the Node.js process — typically
 *     `betterdesk-console` (systemd) which has no sudo by default.
 *     Document this in the install scripts.
 *   • Every session start/end is logged to the audit log.
 */

'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pty = null;
try {
    pty = require('node-pty');
} catch (_) {
    pty = null;
}

const isWindows = process.platform === 'win32';
const DEFAULT_SHELL = isWindows ? (process.env.COMSPEC || 'powershell.exe') : '/bin/bash';
const ALLOWED_LOGIN_SHELLS = new Set([
    '/bin/bash',
    '/bin/sh',
    '/bin/dash',
    '/bin/zsh',
    '/usr/bin/bash',
    '/usr/bin/sh',
    '/usr/bin/dash',
    '/usr/bin/zsh',
]);

function resolveLoginShell(shell) {
    if (isWindows) {
        const winShell = shell || DEFAULT_SHELL;
        if (typeof winShell === 'string' && !/[;&|`$()]/.test(winShell)) {
            return winShell;
        }
        return DEFAULT_SHELL;
    }
    if (typeof shell === 'string' && ALLOWED_LOGIN_SHELLS.has(shell)) {
        return shell;
    }
    if (typeof shell === 'string' && shell.startsWith('/') && !shell.includes('..')) {
        const base = path.basename(shell);
        if (['bash', 'sh', 'dash', 'zsh'].includes(base) && fs.existsSync(shell)) {
            return shell;
        }
    }
    return DEFAULT_SHELL;
}

const ACTIVE_SESSIONS = new Map(); // sessionId -> session
let nextSessionId = 1;

function makeSessionId() {
    const id = nextSessionId++;
    return `srv-term-${Date.now().toString(36)}-${id}`;
}

function parsePasswd() {
    if (isWindows) return [];
    try {
        return fs.readFileSync('/etc/passwd', 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const p = line.split(':');
                return {
                    username: p[0],
                    uid: parseInt(p[2], 10),
                    gid: parseInt(p[3], 10),
                    homedir: p[5] || '/',
                    shell: p[6] || DEFAULT_SHELL
                };
            })
            .filter((u) => Number.isInteger(u.uid) && Number.isInteger(u.gid));
    } catch (_) {
        return [];
    }
}

function validLoginShell(shell) {
    return shell && !/nologin|false$/i.test(shell);
}

function pickTerminalUser() {
    if (isWindows) return { ...os.userInfo(), shell: DEFAULT_SHELL };

    const current = os.userInfo();
    const passwd = parsePasswd();
    const configured = process.env.BETTERDESK_TERMINAL_USER || process.env.SERVER_MANAGEMENT_USER || '';
    const isRootProcess = typeof process.getuid === 'function' && process.getuid() === 0;

    if (configured) {
        const byName = passwd.find((u) => u.username === configured || String(u.uid) === configured);
        if (byName && validLoginShell(byName.shell)) {
            return { ...byName, shell: resolveLoginShell(byName.shell) };
        }
    }

    if (isRootProcess) {
        const localUser = passwd.find((u) =>
            u.uid >= 1000 && u.uid < 60000 &&
            u.username !== 'nobody' &&
            validLoginShell(u.shell) &&
            u.homedir && u.homedir !== '/'
        );
        if (localUser) {
            return { ...localUser, shell: resolveLoginShell(localUser.shell) };
        }
    }

    return {
        username: current.username,
        uid: current.uid,
        gid: current.gid,
        homedir: current.homedir || os.homedir(),
        shell: resolveLoginShell(validLoginShell(process.env.SHELL) ? process.env.SHELL : DEFAULT_SHELL),
    };
}

function buildSpawnOptions(userInfo, cols, rows, ptyMode) {
    const cwd = userInfo.homedir || os.homedir();
    const env = Object.assign({}, process.env, {
        HOME: cwd,
        USER: userInfo.username,
        LOGNAME: userInfo.username,
        SHELL: userInfo.shell || DEFAULT_SHELL,
        TERM: ptyMode ? 'xterm-256color' : 'dumb',
        LANG: process.env.LANG || 'en_US.UTF-8',
        COLUMNS: String(cols || 80),
        LINES: String(rows || 24)
    });
    const options = { cwd, env };
    if (!isWindows && typeof process.getuid === 'function' && process.getuid() === 0 && userInfo.uid !== 0) {
        options.uid = userInfo.uid;
        options.gid = userInfo.gid;
    }
    return options;
}

function spawnPty(cols, rows, userInfo) {
    if (!pty) return null;
    try {
        const options = buildSpawnOptions(userInfo, cols, rows, true);
        const child = pty.spawn(userInfo.shell || DEFAULT_SHELL, [], {
            name: 'xterm-256color',
            cols: cols || 80,
            rows: rows || 24,
            cwd: options.cwd,
            env: options.env,
            uid: options.uid,
            gid: options.gid
        });
        return {
            kind: 'pty',
            child,
            write: (data) => {
                if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
                child.write(data);
            },
            resize: (cols, rows) => {
                try { child.resize(cols, rows); } catch (_) { /* ignore */ }
            },
            onData: (cb) => child.onData(cb),
            onExit: (cb) => child.onExit(cb),
            kill: () => { try { child.kill(); } catch (_) { /* ignore */ } }
        };
    } catch (_) {
        return null;
    }
}

function spawnFallback(cols, rows, userInfo) {
    const args = isWindows ? [] : ['-i'];
    const options = buildSpawnOptions(userInfo, cols, rows, false);
    const child = spawn(userInfo.shell || DEFAULT_SHELL, args, {
        cwd: options.cwd,
        env: options.env,
        uid: options.uid,
        gid: options.gid,
        stdio: ['pipe', 'pipe', 'pipe']
    });
    return {
        kind: 'pipe',
        child,
        write: (data) => {
            try { child.stdin.write(data); } catch (_) { /* ignore */ }
        },
        resize: () => { /* no-op for piped shell */ },
        onData: (cb) => {
            child.stdout.on('data', (b) => cb(b.toString('utf8')));
            child.stderr.on('data', (b) => cb(b.toString('utf8')));
        },
        onExit: (cb) => {
            child.on('exit', (code, signal) => cb({ exitCode: code === null ? -1 : code, signal }));
        },
        kill: () => { try { child.kill(); } catch (_) { /* ignore */ } }
    };
}

function startShell(cols, rows, userInfo) {
    return spawnPty(cols, rows, userInfo) || spawnFallback(cols, rows, userInfo);
}

/**
 * Initialize the Server Management terminal WS proxy.
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware - Express session middleware
 * @param {{logAction?:Function}} [opts]
 */
function initServerTerminalProxy(server, sessionMiddleware, opts) {
    const wss = new WebSocket.Server({ noServer: true });
    const audit = opts && typeof opts.logAction === 'function' ? opts.logAction : null;

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== '/ws/server-management/terminal') return;

        sessionMiddleware(req, {}, () => {
            if (!req.session || !req.session.userId) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                return socket.destroy();
            }
            const sessUser = req.session.user || {};
            const role = sessUser.role || req.session.role || '';
            const username = sessUser.username || `user#${req.session.userId}`;
            // RBAC: only super_admin / admin / server_admin
            if (!(role === 'super_admin' || role === 'admin' || role === 'server_admin')) {
                console.warn(`[srv-term] 403 upgrade rejected (user=${username} role=${role})`);
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                return socket.destroy();
            }
            req._smUserName = username;
            req._smUserRole = role;
            req._smUserId = req.session.userId;
            req._smIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        });
    });

    wss.on('connection', (ws, req) => {
        const sessionId = makeSessionId();
        const username = req._smUserName;
        const role = req._smUserRole;
        const userId = req._smUserId || null;
        const ip = req._smIp || '';
        let shell = null;

        const send = (obj) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
        };

        if (audit) {
            try { audit(userId, 'server_terminal_open', `session=${sessionId} role=${role}`, ip); } catch (_) { /* ignore */ }
        }
        console.log(`[srv-term] session ${sessionId} opened by ${username}`);

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
            if (!msg || typeof msg !== 'object') return;

            if (!shell && msg.type !== 'init') return; // must init first
            switch (msg.type) {
                case 'init': {
                    const cols = Math.max(20, Math.min(500, parseInt(msg.cols, 10) || 80));
                    const rows = Math.max(5, Math.min(200, parseInt(msg.rows, 10) || 24));
                    const terminalUser = pickTerminalUser();
                    shell = startShell(cols, rows, terminalUser);
                    if (!shell) {
                        send({ type: 'error', error: 'failed_to_spawn_shell' });
                        try { ws.close(); } catch (_) { /* ignore */ }
                        return;
                    }
                    ACTIVE_SESSIONS.set(sessionId, shell);
                    send({
                        type: 'ready',
                        session_id: sessionId,
                        kind: shell.kind,
                        shell: terminalUser.shell || DEFAULT_SHELL,
                        platform: process.platform,
                        user: terminalUser.username,
                        cwd: terminalUser.homedir || os.homedir(),
                        pty_available: !!pty
                    });
                    shell.onData((data) => send({ type: 'output', data }));
                    shell.onExit(({ exitCode, signal }) => {
                        send({ type: 'end', reason: 'exit', code: exitCode, signal });
                        try { ws.close(); } catch (_) { /* ignore */ }
                    });
                    break;
                }
                case 'input':
                    if (typeof msg.data === 'string') shell.write(msg.data);
                    break;
                case 'resize': {
                    const cols = Math.max(20, Math.min(500, parseInt(msg.cols, 10) || 80));
                    const rows = Math.max(5, Math.min(200, parseInt(msg.rows, 10) || 24));
                    shell.resize(cols, rows);
                    break;
                }
                case 'close':
                    try { shell.kill(); } catch (_) { /* ignore */ }
                    try { ws.close(); } catch (_) { /* ignore */ }
                    break;
                default:
                    break;
            }
        });

        ws.on('close', () => {
            if (shell) {
                try { shell.kill(); } catch (_) { /* ignore */ }
            }
            ACTIVE_SESSIONS.delete(sessionId);
            if (audit) {
                try { audit(userId, 'server_terminal_close', `session=${sessionId}`, ip); } catch (_) { /* ignore */ }
            }
            console.log(`[srv-term] session ${sessionId} closed`);
        });

        ws.on('error', () => { /* no-op */ });
    });

    wss.on('error', (err) => {
        console.error('[srv-term] wss error:', err && err.message);
    });
}

module.exports = {
    initServerTerminalProxy,
    isPtyAvailable: () => !!pty,
    activeSessionCount: () => ACTIVE_SESSIONS.size
};
