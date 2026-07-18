/**
 * BetterDesk Console - Remote Desktop Routes
 * Serves the web-based remote desktop viewer page (RustDesk compat + BetterDesk native)
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../services/database');
const config = require('../config/config');
const { requireRdClientAuth, rdClientGuestOnly, normalizeRdClientReturnUrl } = require('../middleware/auth');
const { rdClientPageLimiter } = require('../middleware/rateLimiter');
const betterdeskApi = require('../services/betterdeskApi');
const {
    getGuestToken,
    setGuestCookie,
    attachGuestGrant,
    peerAllowedByGrant,
} = require('../middleware/guestAccess');

async function requireRemoteAccess(req, res, next) {
    const deviceId = req.params.deviceId;

    // Multi-device Guest Access Link — token present means guest-only path (no panel login fallback)
    const guestToken = getGuestToken(req);
    if (guestToken && deviceId) {
        try {
            const grant = await attachGuestGrant(req, betterdeskApi, deviceId);
            if (grant && peerAllowedByGrant(grant, deviceId)) {
                setGuestCookie(res, guestToken, grant.expires_at);
                return next();
            }
        } catch {
            // invalid grant
        }
        return res.status(403).render('errors/403', {
            title: req.t('guest_access.invalid_title', 'Invalid guest link'),
            message: req.t('guest_access.device_denied', 'This guest link is invalid, expired, or does not allow this device.'),
        });
    }

    // Legacy mesh single-device share
    const share = String(req.query.mesh_share || '').trim();
    if (share && deviceId) {
        try {
            const result = await betterdeskApi.apiClient.get('/mesh/share/validate', {
                params: { token: share, peer_id: deviceId },
            });
            const data = result.data || {};
            if (data.valid) {
                req.meshShareGrant = data;
                return next();
            }
        } catch {
            // fall through to standard auth
        }
    }
    return requireRdClientAuth('device.connect')(req, res, next);
}

// Lazy-loaded relay helper — avoid circular require at module load time
function getRemoteRelay() {
    try { return require('../services/remoteRelay'); } catch { return null; }
}

// Read server public key once at startup
let serverPubKey = '';
try {
    if (fs.existsSync(config.pubKeyPath)) {
        serverPubKey = fs.readFileSync(config.pubKeyPath, 'utf8').trim();
    }
} catch (err) {
    console.warn('Warning: Could not read server public key:', err.message);
}

/**
 * GET /remote/login - RdClient operator login (when panel session expired)
 */
router.get('/remote/login', rdClientPageLimiter, rdClientGuestOnly, (req, res) => {
    const returnUrl = normalizeRdClientReturnUrl(req.query.return) || '/remote';
    const sessionExpired = req.query.expired === '1' || req.query.expired === 'true';
    res.render('rdclient-login', {
        title: req.t('rdclient_login.title'),
        activePage: 'remote',
        returnUrl,
        sessionExpired,
    });
});

/**
 * GET /remote/guest - Guest Access Link entry (allowlist mini RdClient, no Console).
 */
router.get('/remote/guest', rdClientPageLimiter, async (req, res) => {
    const token = getGuestToken(req);
    if (!token) {
        return res.status(400).render('errors/403', {
            title: req.t('guest_access.invalid_title', 'Invalid guest link'),
            message: req.t('guest_access.missing_token', 'This guest link is missing a token.'),
        });
    }
    try {
        const result = await betterdeskApi.apiClient.get('/guest/access-links/peers', {
            params: { token },
        });
        const data = result.data || {};
        if (!data.valid) {
            return res.status(403).render('errors/403', {
                title: req.t('guest_access.invalid_title', 'Invalid guest link'),
                message: data.error || req.t('guest_access.expired', 'This guest link is invalid or expired.'),
            });
        }
        setGuestCookie(res, token, data.expires_at);
        res.render('remote-guest', {
            title: req.t('guest_access.title', 'Guest Remote'),
            activePage: 'remote',
            guestToken: token,
            guestMeta: {
                view_only: !!data.view_only,
                expires_at: data.expires_at || '',
                label: data.label || '',
                devices: data.devices || [],
            },
        });
    } catch (err) {
        const msg = err.response?.data?.error || err.message;
        return res.status(403).render('errors/403', {
            title: req.t('guest_access.invalid_title', 'Invalid guest link'),
            message: msg,
        });
    }
});

/**
 * GET /remote - RdClient operator dashboard (device list + connect)
 */
router.get('/remote', rdClientPageLimiter, requireRdClientAuth('device.connect'), (req, res) => {
    res.render('remote-dashboard', {
        title: req.t('remote_dashboard.title'),
        activePage: 'remote',
    });
});

/**
 * GET /remote/:deviceId - Unified remote desktop viewer (single entry point).
 */
router.get('/remote/:deviceId', rdClientPageLimiter, requireRemoteAccess, async (req, res) => {
    const deviceId = req.params.deviceId;

    if (!deviceId || deviceId === 'login' || !/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect('/devices');
    }

    let device = null;
    try {
        device = await db.getDevice(deviceId);
    } catch {
        // Database lookup failure is non-blocking - viewer can still work
    }

    let isOsAgent = false;
    let isCdapConnected = false;
    let isMeshAgent = false;
    let meshConnected = false;
    let goPeer = null;
    try {
        const api = require('../services/betterdeskApi');
        goPeer = await api.getPeer(deviceId);
        if (goPeer) {
            isOsAgent = String(goPeer.device_type || '').toLowerCase() === 'os_agent';
            isCdapConnected = !!goPeer.cdap_connected;
            isMeshAgent = String(goPeer.device_type || '').toLowerCase() === 'mesh_agent';
            meshConnected = !!goPeer.mesh_connected;
        }
    } catch { /* non-fatal: degrade to standard viewer */ }

    const forced = String(req.query.transport || '').toLowerCase();
    let transport;
    if (forced === 'mesh' || forced === 'cdap' || forced === 'rd') {
        transport = forced;
    } else if (isMeshAgent && meshConnected) {
        transport = 'mesh';
    } else if (isOsAgent || isCdapConnected) {
        transport = 'cdap';
    } else {
        transport = 'rd';
    }

    const capabilities = {
        transport,
        os_agent: isOsAgent,
        cdap_connected: isCdapConnected,
        mesh_connected: meshConnected,
        device_type: goPeer && goPeer.device_type ? String(goPeer.device_type) : '',
        mesh_share: req.meshShareGrant ? true : false,
        mesh_view_only: req.meshShareGrant && req.meshShareGrant.view_only ? true : false,
        guest_access: !!req.guestGrant,
        guest_view_only: !!(req.guestGrant && req.guestGrant.view_only),
        guest_peer_ids: req.guestGrant && Array.isArray(req.guestGrant.peer_ids) ? req.guestGrant.peer_ids : [],
    };

    res.render('remote', {
        title: `${req.t('remote.title')} - ${deviceId}`,
        activePage: 'remote',
        deviceId: deviceId,
        device: device || { id: deviceId, hostname: '', platform: '', note: '' },
        serverPubKey: serverPubKey,
        capabilities,
        layout: 'viewer'
    });
});

/**
 * GET /remote-cdap/:deviceId - Legacy alias, redirects to unified entry.
 */
router.get('/remote-cdap/:deviceId', rdClientPageLimiter, requireRdClientAuth('device.connect'), (req, res) => {
    const deviceId = req.params.deviceId;
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect(`/remote/${encodeURIComponent(deviceId)}?transport=cdap`);
    }
    return res.redirect('/devices');
});

/**
 * GET /remote-desktop/:deviceId - Legacy route, redirects to unified /remote/:deviceId
 */
router.get('/remote-desktop/:deviceId', rdClientPageLimiter, requireRdClientAuth('device.connect'), (req, res) => {
    const deviceId = req.params.deviceId;
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect(`/remote/${encodeURIComponent(deviceId)}`);
    }
    return res.redirect('/devices');
});

/**
 * GET /api/remote/sessions - List active native remote sessions
 */
router.get('/api/remote/sessions', requireRdClientAuth(), (req, res) => {
    const relay = getRemoteRelay();
    if (!relay) return res.json({ sessions: [] });
    const sessions = relay.getActiveSessions();
    res.json({ sessions });
});

/**
 * GET /api/remote/session/:deviceId - Get state of a single native remote session
 */
router.get('/api/remote/session/:deviceId', requireRdClientAuth(), (req, res) => {
    const relay = getRemoteRelay();
    if (!relay) return res.status(404).json({ error: 'Remote relay not available' });
    const state = relay.getSessionState(req.params.deviceId);
    if (!state) return res.status(404).json({ error: 'Session not found' });
    res.json(state);
});

module.exports = router;
