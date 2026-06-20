/**
 * BetterDesk Console — Desktop Client API Routes
 *
 * REST endpoints consumed by the BetterDesk desktop client (Tauri).
 * These run on the main console server (port 5000) under /api/bd/*.
 *
 * Endpoints:
 *   POST   /api/bd/register     — Register / heartbeat a desktop device
 *   POST   /api/bd/connect      — Request relay session to a target device
 *   GET    /api/bd/session/:id  — Check session status
 *   POST   /api/bd/heartbeat    — Lightweight keepalive
 *   GET    /api/bd/peers        — List online peers (requires auth)
 *   GET    /api/bd/peer/:id     — Get single peer info
 *   DELETE /api/bd/session/:id  — Cancel/close a relay session
 *
 * Authentication:
 *   Desktop clients authenticate via access tokens (Bearer header) obtained
 *   from the RustDesk Client API (/api/login on port 21121).
 *   Token is validated with the same authService.
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const config = require('../config/config');
const db = require('../services/database');
const bdRelay = require('../services/bdRelay');
const brandingService = require('../services/brandingService');
const authService = require('../services/authService');
const betterdeskApi = require('../services/betterdeskApi');

// ---------------------------------------------------------------------------
//  Help requests & chat are stored on the Go server (single source of truth).
//  The panel is a read proxy: it forwards reads/writes to the Go REST API and
//  fans out Go events to browsers via socket.io (see helpChatPush service).
//
//  Go uses status values pending/acknowledged/resolved/cancelled. The panel UI
//  historically uses pending/accepted/resolved, so we normalize on the way out.
// ---------------------------------------------------------------------------

/** Map a Go help-request record to the shape the panel UI expects. */
function normalizeHelpRequest(r) {
    if (!r || typeof r !== 'object') return null;
    const statusMap = { acknowledged: 'accepted' };
    const createdMs = r.created_at ? Date.parse(r.created_at) : Date.now();
    return {
        id: String(r.id),
        device_id: r.device_id || '',
        hostname: r.hostname || '',
        message: r.message || '',
        status: statusMap[r.status] || r.status || 'pending',
        accepted_by: r.status === 'acknowledged' ? (r.handled_by || '') : '',
        resolved_by: r.status === 'resolved' ? (r.handled_by || '') : '',
        created_at: Number.isFinite(createdMs) ? createdMs : Date.now(),
    };
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

function extractBearerToken(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.substring(7).trim();
}

function requireOperatorRole(req, res, next) {
    const role = req.deviceUser?.role;
    if (role !== 'admin' && role !== 'operator') {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
}

function normalizeSessionAction(value) {
    const action = String(value || '').trim().toLowerCase();
    if (action === 'start' || action === 'session_start') return 'session_start';
    if (action === 'end' || action === 'session_end') return 'session_end';
    return null;
}

function toTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildSessionHistory(entries, limit) {
    const now = Date.now();
    const grouped = new Map();

    const rows = [...entries]
        .filter((entry) => entry.action === 'session_start' || entry.action === 'session_end')
        .sort((a, b) => toTimestamp(a.created_at) - toTimestamp(b.created_at));

    for (const entry of rows) {
        const key = entry.session_id || `${entry.host_id}:${entry.peer_id}:${entry.id}`;
        const existing = grouped.get(key) || {
            id: key,
            device_id: entry.peer_id || '',
            hostname: entry.peer_name || '',
            operator: entry.host_id || 'operator',
            started_at: '',
            ended_at: '',
            duration_secs: 0,
            action: entry.action || 'session_start',
        };

        if (!existing.device_id && entry.peer_id) existing.device_id = entry.peer_id;
        if (!existing.hostname && entry.peer_name) existing.hostname = entry.peer_name;
        if (!existing.operator && entry.host_id) existing.operator = entry.host_id;

        if (entry.action === 'session_start') {
            existing.started_at = String(entry.created_at || existing.started_at || '');
            existing.action = 'session_start';
        }
        if (entry.action === 'session_end') {
            existing.ended_at = String(entry.created_at || existing.ended_at || '');
            existing.action = 'session_end';
        }

        grouped.set(key, existing);
    }

    return [...grouped.values()]
        .map((entry) => {
            const started = toTimestamp(entry.started_at);
            const ended = entry.ended_at ? toTimestamp(entry.ended_at) : now;
            if (started > 0 && ended >= started) {
                entry.duration_secs = Math.max(0, Math.round((ended - started) / 1000));
            }
            return entry;
        })
        .sort((a, b) => toTimestamp(b.started_at || b.ended_at) - toTimestamp(a.started_at || a.ended_at))
        .slice(0, limit);
}

// ---------------------------------------------------------------------------
//  GET /api/bd/server-info — Public panel identity (RdClient URL validation)
// ---------------------------------------------------------------------------

router.get('/server-info', (_req, res) => {
    const branding = brandingService.getBranding();
    res.json({
        ok: true,
        product: 'betterdesk-panel',
        version: config.appVersion,
        panel_name: branding.appName || config.appName,
        appearance_contract: {
            version: '2.0',
            endpoint: '/api/bd/appearance',
            revision: brandingService.getBrandingRevision()
        },
    });
});

// ---------------------------------------------------------------------------
//  Middleware — authenticate desktop client via access token or session cookie
// ---------------------------------------------------------------------------

async function requireDeviceAuth(req, res, next) {
    // SECURITY (audit fix H-02, 2026-04-10): /api/bd/* now accepts ONLY
    // Bearer access tokens. The previous session-cookie fallback combined
    // with the CSRF skip for /api/bd/* enabled CSRF on device-management
    // endpoints when called from an authenticated browser session.
    // Browser-based operators must obtain a Bearer token from
    // POST /api/auth/access-token before calling /api/bd/* endpoints.
    const token = extractBearerToken(req);
    if (token) {
        try {
            const tokenRow = await db.getAccessToken(token);
            if (tokenRow) {
                const user = await db.getUserById(tokenRow.user_id);
                req.deviceToken = tokenRow;
                req.deviceUser = user || null;
                await db.touchAccessToken(token);
                return next();
            }
        } catch (err) {
            console.error('[BD-API] Token auth error:', err.message);
        }
    }

    // Log auth attempt without leaking the token (redact entirely).
    const hasAuth = !!req.headers['authorization'];
    console.warn(`[BD-API] Auth FAILED ${req.method} ${req.path} — Bearer=${hasAuth ? '[present-invalid]' : '[absent]'} ip=${req.ip}`);
    return res.status(401).json({ error: 'Missing or invalid Bearer access token' });
}

/**
 * Lightweight auth — token OR device_id header (for unauthenticated heartbeat).
 * Sets req.deviceId from token's client_id or from X-Device-Id header.
 */
async function identifyDevice(req, res, next) {
    const token = extractBearerToken(req);
    if (token) {
        try {
            const tokenRow = await db.getAccessToken(token);
            if (tokenRow) {
                req.deviceId = tokenRow.client_id || null;
                req.deviceToken = tokenRow;
                await db.touchAccessToken(token);
                return next();
            }
        } catch (_) {}
    }
    // Fallback: X-Device-Id header (for registration before login)
    const deviceId = req.headers['x-device-id'];
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        req.deviceId = deviceId;
        return next();
    }
    return res.status(401).json({ error: 'Missing device identification' });
}

// ---------------------------------------------------------------------------
//  POST /api/bd/register — Register or update a desktop device
// ---------------------------------------------------------------------------

router.post('/register', identifyDevice, async (req, res) => {
    try {
        const ip = getClientIp(req);
        const { device_id, uuid, hostname, platform, version, public_key } = req.body;

        const id = device_id || req.deviceId;
        if (!id) {
            return res.status(400).json({ error: 'device_id is required' });
        }

        // Reject registration with a stale/renamed peer ID (Issue #97)
        const newId = db.getRenamedPeerId ? await db.getRenamedPeerId(id) : null;
        if (newId) {
            return res.status(409).json({
                error: 'Device ID has been changed',
                new_id: newId,
                message: `This device ID was renamed to ${newId}. Please update your configuration.`,
            });
        }

        // Build info JSON
        const info = JSON.stringify({
            hostname: hostname || '',
            os: platform || '',
            version: version || '',
            ip: ip,
        });

        // Upsert peer in DB
        await db.upsertPeer({ id, uuid: uuid || '', pk: public_key || null, info, ip });

        // Update online status
        try {
            await db.updatePeerOnlineStatus(id);
        } catch (_) {}

        res.json({
            success: true,
            device_id: id,
            server_time: Date.now(),
            heartbeat_interval: 15, // seconds
        });
    } catch (err) {
        console.error('[BD-API] Register error:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/heartbeat — Lightweight keepalive
// ---------------------------------------------------------------------------

router.post('/heartbeat', identifyDevice, async (req, res) => {
    try {
        const id = req.body.device_id || req.deviceId;
        if (!id) {
            return res.status(400).json({ error: 'device_id is required' });
        }

        // Touch online status
        try {
            await db.updatePeerOnlineStatus(id);
        } catch (_) {}

        // Check for pending incoming connection requests
        const pending = [];
        for (const [sid, session] of bdRelay.activeSessions) {
            if (session.targetId === id && session.status === 'pending') {
                pending.push({
                    session_id: sid,
                    initiator_id: session.initiatorId,
                    created_at: session.createdAt,
                });
            }
        }

        res.json({
            success: true,
            server_time: Date.now(),
            pending_connections: pending,
        });
    } catch (err) {
        console.error('[BD-API] Heartbeat error:', err.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/connect — Request relay session to a target device
// ---------------------------------------------------------------------------

router.post('/connect', requireDeviceAuth, async (req, res) => {
    try {
        const { target_id, initiator_id, public_key } = req.body;

        if (!target_id) {
            return res.status(400).json({ error: 'target_id is required' });
        }

        const srcId = initiator_id || req.deviceToken?.client_id;
        if (!srcId) {
            return res.status(400).json({ error: 'initiator_id is required' });
        }

        // Check if target exists
        const target = await db.getDeviceById(target_id);
        if (!target) {
            return res.status(404).json({ error: 'Target device not found' });
        }

        // Check if target is banned
        if (target.is_banned) {
            return res.status(403).json({ error: 'Target device is banned' });
        }

        // Create relay session
        const { sessionId, initiatorToken, targetToken } = bdRelay.createRelaySession(srcId, target_id);

        // Try to notify target via WebSocket signal channel
        const targetNotified = bdRelay.notifyTarget(target_id, {
            type: 'incoming_connection',
            session_id: sessionId,
            initiator_id: srcId,
            initiator_pk: public_key || null,
        });

        res.json({
            success: true,
            session_id: sessionId,
            token: initiatorToken,
            target_online: targetNotified,
            relay_url: `/ws/bd-relay?session=${sessionId}&token=${initiatorToken}&role=initiator`,
        });
    } catch (err) {
        console.error('[BD-API] Connect error:', err.message);
        res.status(500).json({ error: 'Connection request failed' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/session/:id — Check session status
// ---------------------------------------------------------------------------

router.get('/session/:id', identifyDevice, (req, res) => {
    const session = bdRelay.getRelaySession(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    res.json({ success: true, session });
});

// ---------------------------------------------------------------------------
//  DELETE /api/bd/session/:id — Cancel relay session
// ---------------------------------------------------------------------------

router.delete('/session/:id', identifyDevice, (req, res) => {
    const sessionId = req.params.id;
    const session = bdRelay.getRelaySession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    // Only participants can cancel
    const id = req.deviceId;
    if (session.initiatorId !== id && session.targetId !== id) {
        return res.status(403).json({ error: 'Not a participant of this session' });
    }
    // Teardown handled internally
    bdRelay.activeSessions.delete(sessionId);
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
//  GET /api/bd/peers — List online peers
// ---------------------------------------------------------------------------

router.get('/peers', requireDeviceAuth, async (req, res) => {
    try {
        const onlineIds = bdRelay.getOnlineDeviceIds();
        const peers = [];

        for (const id of onlineIds) {
            const device = await db.getDeviceById(id);
            if (device && !device.is_banned && !device.is_deleted) {
                peers.push({
                    id: device.id,
                    hostname: device.note || '',
                    platform: '',
                    online: true,
                });
            }
        }

        res.json({ success: true, peers });
    } catch (err) {
        console.error('[BD-API] Peers error:', err.message);
        res.status(500).json({ error: 'Failed to list peers' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/peer/:id — Get single peer info
// ---------------------------------------------------------------------------

router.get('/peer/:id', identifyDevice, async (req, res) => {
    try {
        const device = await db.getDeviceById(req.params.id);
        if (!device) {
            return res.status(404).json({ error: 'Device not found' });
        }
        res.json({
            success: true,
            peer: {
                id: device.id,
                hostname: device.note || '',
                online: bdRelay.isDeviceOnline(device.id),
                banned: !!device.is_banned,
            },
        });
    } catch (err) {
        console.error('[BD-API] Peer error:', err.message);
        res.status(500).json({ error: 'Failed to get peer info' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/branding — Public branding for desktop client (no auth)
// ---------------------------------------------------------------------------

router.get('/branding', (req, res) => {
    try {
        const branding = brandingService.getBranding();
        const publicAppearance = brandingService.getPublicAppearance();
        res.json({
            company_name: branding.appName || 'BetterDesk',
            accent_color: branding.colors?.accentBlue || '#3b82f6',
            support_contact: branding.supportContact || '',
            appearance: publicAppearance
        });
    } catch (err) {
        console.error('[BD-API] Branding error:', err.message);
        // Return defaults on error — never block the client
        res.json({
            company_name: 'BetterDesk',
            accent_color: '#3b82f6',
            support_contact: '',
        });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/appearance — Public, sanitized appearance contract for RdClient
// ---------------------------------------------------------------------------

router.get('/appearance', (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.json({ success: true, data: brandingService.getPublicAppearance() });
    } catch (err) {
        console.error('[BD-API] Appearance error:', err.message);
        res.json({
            success: true,
            data: {
                version: '2.0',
                revision: 'fallback',
                product: 'betterdesk-appearance',
                identity: { appName: 'BetterDesk', logoType: 'icon', logoIcon: 'dns' },
                palette: {
                    mode: 'dark',
                    primary: '#58a6ff',
                    background: '#0d1117',
                    surface: '#161b22',
                    surfaceRaised: '#21262d',
                    text: '#e6edf3',
                    muted: '#8b949e',
                    border: '#30363d',
                    danger: '#f85149',
                    warning: '#d29922',
                    success: '#2ea44f'
                },
                surfaces: { glassEnabled: true, glassBlur: '16', glassOpacity: '55' },
                background: { type: 'none', color: '', gradient: '', imageUrl: '', overlay: '', size: 'cover' },
                readability: { ok: true, issues: [] }
            }
        });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-request — Desktop client requests operator assistance
// ---------------------------------------------------------------------------

router.post('/help-request', identifyDevice, async (req, res) => {
    try {
        const { device_id, hostname, message } = req.body;

        if (!device_id || typeof device_id !== 'string') {
            return res.status(400).json({ error: 'Missing device_id' });
        }

        const cleanDeviceId = String(device_id).substring(0, 32);
        const cleanHostname = String(hostname || '').substring(0, 128);
        const cleanMessage = String(message || '').substring(0, 500);

        // Help requests live on the Go server. Legacy agents that still POST to
        // the panel are proxied through; modern agents send help requests over
        // CDAP directly. The Go server publishes a help_request event which the
        // helpChatPush service fans out to browser clients.
        let requestId = null;
        try {
            const goRes = await betterdeskApi.apiClient.post('/help/requests', {
                device_id: cleanDeviceId,
                hostname: cleanHostname,
                message: cleanMessage,
            });
            requestId = goRes.data && (goRes.data.id || goRes.data.request_id);
        } catch (goErr) {
            console.warn('[BD-API] Help request Go proxy failed:', goErr.message);
        }

        // Audit locally for history/searchability.
        await db.logAction(null, 'help_request', `Help requested by ${cleanDeviceId}: ${cleanMessage}`, getClientIp(req));

        console.log(`[BD-API] Help request from ${cleanDeviceId} (${cleanHostname}): ${cleanMessage}`);

        res.json({ success: true, request_id: requestId ? String(requestId) : crypto.randomUUID() });
    } catch (err) {
        console.error('[BD-API] Help request error:', err.message);
        res.status(500).json({ error: 'Failed to process help request' });
    }
});

// ===========================================================================
//  Operator Authentication (desktop client operator mode)
// ===========================================================================

// ---------------------------------------------------------------------------
//  POST /api/bd/chat/send — Agent client sends a message to connected operators
// ---------------------------------------------------------------------------

// Chat messages are persisted on the Go server (single source of truth). The
// panel proxies sends/reads through the Go REST API. Live fan-out to operator
// browsers happens through the Go event bus (see helpChatPush service).

router.post('/chat/send', identifyDevice, async (req, res) => {
    try {
        const { device_id, sender, content, timestamp } = req.body;

        if (!device_id || typeof device_id !== 'string') {
            return res.status(400).json({ error: 'Missing device_id' });
        }
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'Missing content' });
        }
        if (content.length > 4096) {
            return res.status(400).json({ error: 'Message too long (max 4096 chars)' });
        }

        const cleanDeviceId = String(device_id).slice(0, 64);
        const sanitizedSender = typeof sender === 'string' ? sender.trim().slice(0, 128) : cleanDeviceId;

        // conversation_id is the device id; from_id identifies the device sender.
        const result = await betterdeskApi.sendChatMessage({
            conversation_id: cleanDeviceId,
            from_id: cleanDeviceId,
            from_name: sanitizedSender,
            to_id: '',
            text: content.trim().slice(0, 4096),
        });

        if (!result.success) {
            console.warn('[BD-API] Chat send Go proxy failed:', result.error);
            return res.status(502).json({ error: 'Failed to send message' });
        }

        const messageId = result.data && (result.data.id || result.data.message_id);
        res.json({ success: true, message_id: messageId ? String(messageId) : `${Date.now()}` });
    } catch (err) {
        console.error('[BD-API] Chat send error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/chat/history — Fetch recent messages for a device
// ---------------------------------------------------------------------------

router.get('/chat/history', requireDeviceAuth, async (req, res) => {
    const deviceId = String(req.query.device_id || '').slice(0, 64);
    if (!deviceId) return res.status(400).json({ error: 'Missing device_id' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const result = await betterdeskApi.getChatHistory(deviceId, limit);
    if (!result.success) {
        console.warn('[BD-API] Chat history Go proxy failed:', result.error);
        return res.json([]);
    }

    // Map Go chat messages to the panel's {id, device_id, sender, content, timestamp} shape.
    const history = (result.data || []).map((m) => ({
        id: String(m.id),
        device_id: m.conversation_id || deviceId,
        sender: m.from_name || m.from_id || '',
        content: m.text || '',
        timestamp: m.created_at || new Date().toISOString(),
    }));
    res.json(history.slice(-limit));
});

// ---------------------------------------------------------------------------
//  POST /api/bd/operator/login — Authenticate operator from desktop client
// ---------------------------------------------------------------------------

router.post('/operator/login', async (req, res) => {
    try {
        const ip = getClientIp(req);
        const { username, password, device_id } = req.body;

        if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Brute-force protection
        const blocked = await authService.checkBruteForce(username, ip);
        if (blocked) {
            return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
        }

        // Authenticate
        const user = await authService.authenticate(username, password);
        if (authService.isAuthFailure(user) && user.__authFailure === 'username_collision') {
            authService.recordAttempt(username, ip, false);
            return res.status(409).json({ error: 'Username collision: a local account with this name already exists', code: 'username_collision' });
        }
        if (!user) {
            authService.recordAttempt(username, ip, false);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Only admin and operator roles can use operator mode
        if (user.role !== 'admin' && user.role !== 'operator') {
            authService.recordAttempt(username, ip, false);
            return res.status(403).json({ error: 'Insufficient permissions. Admin or operator role required.' });
        }

        // Issue access token
        authService.recordAttempt(username, ip, true);
        const token = await authService.generateAccessToken(
            user.id,
            String(device_id || '').substring(0, 32),
            '',
            ip
        );
        await db.updateLastLogin(user.id);

        await db.logAction(user.id, 'operator_login', `Operator login from desktop client (${device_id || 'unknown'})`, ip);

        res.json({
            access_token: token,
            user: {
                name: user.username || user.name || username,
                role: user.role,
            },
        });
    } catch (err) {
        console.error('[BD-API] Operator login error:', err.message);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/operator/devices — List all devices (requires operator auth)
// ---------------------------------------------------------------------------

router.get('/operator/devices', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        // Only admin/operator can list devices
        if (req.deviceUser && req.deviceUser.role !== 'admin' && req.deviceUser.role !== 'operator') {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const peers = await db.getAllPeers({});
        const devices = peers.map((p) => {
            let hostname = '';
            let platform = '';
            try {
                const info = typeof p.info === 'string' ? JSON.parse(p.info) : (p.info || {});
                hostname = info.hostname || p.note || '';
                platform = info.os || info.platform || '';
            } catch (_) {
                hostname = p.note || '';
            }
            return {
                id: p.id,
                hostname: hostname,
                platform: platform,
                online: !!(p.status_online || p.online),
                last_online: p.last_online || '',
            };
        });

        res.json({ success: true, devices });
    } catch (err) {
        console.error('[BD-API] Operator devices error:', err.message);
        res.status(500).json({ error: 'Failed to fetch devices' });
    }
});

// ===========================================================================
//  Help Request Management (web panel operators)
// ===========================================================================

// ---------------------------------------------------------------------------
//  GET /api/bd/help-requests — List all help requests (requires auth)
// ---------------------------------------------------------------------------

router.get('/help-requests', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        const filter = { limit: 200 };
        if (req.query.status) filter.status = String(req.query.status);
        if (req.query.device_id) filter.device_id = String(req.query.device_id);

        const result = await betterdeskApi.listHelpRequests(filter);
        if (!result.success) {
            console.warn('[BD-API] List help requests Go proxy failed:', result.error);
            return res.json({ success: true, requests: [] });
        }

        const items = (result.data || [])
            .map(normalizeHelpRequest)
            .filter(Boolean)
            .sort((a, b) => b.created_at - a.created_at);

        res.json({ success: true, requests: items });
    } catch (err) {
        console.error('[BD-API] List help requests error:', err.message);
        res.status(500).json({ error: 'Failed to list help requests' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-requests/:id/accept — Accept a help request
// ---------------------------------------------------------------------------

router.post('/help-requests/:id/accept', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        const result = await betterdeskApi.acknowledgeHelpRequest(req.params.id);
        if (!result.success) {
            console.warn('[BD-API] Accept help request Go proxy failed:', result.error);
            return res.status(502).json({ error: 'Failed to accept help request' });
        }

        await db.logAction(
            req.deviceUser?.id || null,
            'help_request_accept',
            `Accepted help request ${req.params.id}`,
            getClientIp(req)
        );

        res.json({ success: true, request: result.data });
    } catch (err) {
        console.error('[BD-API] Accept help request error:', err.message);
        res.status(500).json({ error: 'Failed to accept help request' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-requests/:id/resolve — Resolve a help request
// ---------------------------------------------------------------------------

router.post('/help-requests/:id/resolve', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        const result = await betterdeskApi.resolveHelpRequest(req.params.id);
        if (!result.success) {
            console.warn('[BD-API] Resolve help request Go proxy failed:', result.error);
            return res.status(502).json({ error: 'Failed to resolve help request' });
        }

        await db.logAction(
            req.deviceUser?.id || null,
            'help_request_resolve',
            `Resolved help request ${req.params.id}`,
            getClientIp(req)
        );

        res.json({ success: true, request: result.data });
    } catch (err) {
        console.error('[BD-API] Resolve help request error:', err.message);
        res.status(500).json({ error: 'Failed to resolve help request' });
    }
});

// ---------------------------------------------------------------------------
//  DELETE /api/bd/help-requests/:id — Delete a help request
// ---------------------------------------------------------------------------

router.delete('/help-requests/:id', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        // The Go server has no hard-delete for help requests; closing it (resolve)
        // removes it from the active list, which is what the panel UI expects.
        const result = await betterdeskApi.resolveHelpRequest(req.params.id);
        if (!result.success) {
            console.warn('[BD-API] Delete help request Go proxy failed:', result.error);
            return res.status(502).json({ error: 'Failed to delete help request' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[BD-API] Delete help request error:', err.message);
        res.status(500).json({ error: 'Failed to delete help request' });
    }
});

// ===========================================================================
//  Notification Center (panel navbar bell)
// ===========================================================================
//
//  These routes are consumed by web-nodejs/public/js/notif-center.js. They use
//  session-based auth (panel cookies) rather than Bearer tokens because the
//  dropdown is part of the web UI, not the desktop client.
//
//  Storage model: notifications are a per-user read-status overlay over
//  helpRequests. Read state is persisted in notification_reads (per user).
// ---------------------------------------------------------------------------

const { requireAuth } = require('../middleware/auth');

function sessionUserId(req) {
    return req.session?.userId ?? req.session?.user?.id ?? null;
}

function helpRequestToNotif(req, readIds) {
    return {
        id: req.id,
        title: req.hostname || req.device_id,
        message: req.message || '',
        icon: 'support_agent',
        link: '/help-requests',
        read: readIds.has(String(req.id)),
        created_at: new Date(req.created_at).toISOString(),
        kind: 'help_request',
        status: req.status,
    };
}

// ---------------------------------------------------------------------------
//  GET /api/bd/notifications — list recent notifications for current user
// ---------------------------------------------------------------------------

router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const rawLimit = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20;
        const unreadOnly = String(req.query.unread_only || '').toLowerCase() === 'true';
        const userId = sessionUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const readIds = await db.getReadNotificationIds(userId);
        const result = await betterdeskApi.listHelpRequests({ limit: 200 });
        const requests = (result.success ? (result.data || []) : [])
            .map(normalizeHelpRequest)
            .filter(Boolean);

        const items = requests
            .sort((a, b) => b.created_at - a.created_at)
            .map(r => helpRequestToNotif(r, readIds))
            .filter(n => (unreadOnly ? !n.read : true))
            .slice(0, limit);

        const unreadCount = requests
            .filter(r => !readIds.has(String(r.id))).length;

        res.json({ success: true, items, unread_count: unreadCount });
    } catch (err) {
        console.error('[BD-API] List notifications error:', err.message);
        res.status(500).json({ error: 'Failed to list notifications' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/notifications/:id/read — mark single notification read
// ---------------------------------------------------------------------------

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
    try {
        const userId = sessionUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const id = String(req.params.id || '').slice(0, 128);
        // Idempotent: the help request lives on the Go server; the read overlay
        // is a local per-user state, so we simply record it.
        await db.markNotificationRead(userId, id);
        res.json({ success: true });
    } catch (err) {
        console.error('[BD-API] Mark notification read error:', err.message);
        res.status(500).json({ error: 'Failed to mark notification read' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/notifications/read-all — mark all notifications read
// ---------------------------------------------------------------------------

router.post('/notifications/read-all', requireAuth, async (req, res) => {
    try {
        const userId = sessionUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const result = await betterdeskApi.listHelpRequests({ limit: 200 });
        const requests = (result.success ? (result.data || []) : [])
            .map(normalizeHelpRequest)
            .filter(Boolean);
        await db.markAllNotificationsRead(userId, requests.map((r) => r.id));

        res.json({ success: true });
    } catch (err) {
        console.error('[BD-API] Mark all read error:', err.message);
        res.status(500).json({ error: 'Failed to mark all notifications read' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/operator/sessions — Record operator session start/end
// ---------------------------------------------------------------------------

router.post('/operator/sessions', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        const action = normalizeSessionAction(req.body?.action);
        const deviceId = String(req.body?.device_id || '').trim();
        const hostname = String(req.body?.hostname || '').trim().substring(0, 128);
        const sessionId = String(req.body?.session_id || crypto.randomUUID()).trim().substring(0, 96);

        if (!action) {
            return res.status(400).json({ error: 'Invalid session action' });
        }
        if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
            return res.status(400).json({ error: 'Invalid device_id' });
        }

        const operatorName = req.deviceUser?.username || req.deviceUser?.name || 'operator';
        const operatorClientId = String(req.deviceToken?.client_id || '').substring(0, 64);

        await db.insertAuditConnection({
            host_id: operatorName,
            host_uuid: operatorClientId,
            peer_id: deviceId,
            peer_name: hostname,
            action,
            conn_type: 1,
            session_id: sessionId,
            ip: getClientIp(req),
        });

        res.json({ success: true, session_id: sessionId, action });
    } catch (err) {
        console.error('[BD-API] Record operator session error:', err.message);
        res.status(500).json({ error: 'Failed to record operator session' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/operator/sessions — Operator session history
// ---------------------------------------------------------------------------

router.get('/operator/sessions', requireDeviceAuth, requireOperatorRole, async (req, res) => {
    try {
        const requestedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(requestedLimit, 1), 200)
            : 100;

        const rows = await db.getAuditConnections({
            limit: limit * 4,
            offset: 0,
        });

        const sessions = buildSessionHistory(rows || [], limit);
        res.json({ success: true, sessions, count: sessions.length });
    } catch (err) {
        console.error('[BD-API] Session history error:', err.message);
        res.status(500).json({ error: 'Failed to fetch session history' });
    }
});

module.exports = router;
