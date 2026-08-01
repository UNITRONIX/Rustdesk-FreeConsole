/**
 * BetterDesk Console - Remote Desktop Routes
 * Serves the web-based remote desktop viewer page (RustDesk compat + BetterDesk native)
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const logger = require('../lib/logger').child('REMOTE');
const { requireRdClientAuth, rdClientGuestOnly, normalizeRdClientReturnUrl, roleHasPermission } = require('../middleware/auth');
const { rdClientPageLimiter } = require('../middleware/rateLimiter');
const betterdeskApi = require('../services/betterdeskApi');
const keyService = require('../services/keyService');
const {
    getGuestToken,
    getGuestTokenFromQuery,
    setGuestCookie,
    clearGuestCookie,
    attachGuestGrant,
    peerAllowedByGrant,
} = require('../middleware/guestAccess');

async function requireRemoteAccess(req, res, next) {
    const deviceId = req.params.deviceId;

    // Panel session with device.connect wins over a stale guest cookie (avoids hijack 403).
    const role = req.session && req.session.user && req.session.user.role;
    if (req.session && req.session.userId && role !== 'pro' && roleHasPermission(role, 'device.connect')) {
        return requireRdClientAuth('device.connect')(req, res, next);
    }

    const queryToken = getGuestTokenFromQuery(req);
    const guestToken = getGuestToken(req);

    // Guest Access Link — hard deny only for an explicit ?guest= / ?t= without a valid grant.
    // Cookie-only failures fall through to panel auth / login.
    if (guestToken && deviceId) {
        try {
            const grant = await attachGuestGrant(req, betterdeskApi, deviceId);
            if (grant && peerAllowedByGrant(grant, deviceId)) {
                setGuestCookie(res, guestToken, grant.expires_at);
                return next();
            }
        } catch (err) {
            logger.warn('Guest grant validate failed:', err.message || err);
        }
        if (queryToken) {
            logger.info('Guest remote deny (explicit query, invalid/expired/not allowed):', deviceId);
            return res.status(403).render('errors/403', {
                title: req.t('guest_access.invalid_title', 'Invalid guest link'),
                message: req.t('guest_access.device_denied', 'This guest link is invalid, expired, or does not allow this device.'),
            });
        }
        logger.debug('Stale guest cookie ignored; falling through to panel auth');
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

// Resolve server public key on each viewer render (file may be stale/wrong;
// fall back to live Go /api/server-key — issue #340).
async function resolveServerPubKey() {
    try {
        return (await keyService.resolvePublicKey()) || '';
    } catch (err) {
        console.warn('Warning: Could not resolve server public key:', err.message);
        return '';
    }
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
            logger.info('Guest peers invalid/expired');
            return res.status(403).render('errors/403', {
                title: req.t('guest_access.invalid_title', 'Invalid guest link'),
                message: data.error || req.t('guest_access.expired', 'This guest link is invalid or expired.'),
            });
        }
        setGuestCookie(res, token, data.expires_at);
        const guestMeta = {
            view_only: !!data.view_only,
            expires_at: data.expires_at || '',
            label: data.label || '',
            devices: data.devices || [],
        };
        try {
            res.render('remote-guest', {
                title: req.t('guest_access.title', 'Guest Remote'),
                activePage: 'remote',
                guestToken: token,
                guestMeta,
            });
        } catch (renderErr) {
            logger.error('Guest remote-guest render failed:', renderErr);
            if (!res.headersSent) {
                res.status(500).type('text/plain').send(
                    'Guest Remote page failed to render. Check console logs (LOG_LEVEL=info) and try again after updating.'
                );
            }
        }
    } catch (err) {
        logger.warn('Guest /remote/guest peers/API error:', err.response?.data?.error || err.message);
        if (!res.headersSent) {
            return res.status(403).render('errors/403', {
                title: req.t('guest_access.invalid_title', 'Invalid guest link'),
                message: err.response?.data?.error || err.message,
            });
        }
    }
});

/**
 * GET /remote - RdClient operator dashboard (device list + connect)
 */
router.get('/remote', rdClientPageLimiter, requireRdClientAuth('device.connect'), (req, res) => {
    clearGuestCookie(res);
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
        serverPubKey: await resolveServerPubKey(),
        capabilities,
        guestToken: req.guestToken || getGuestTokenFromQuery(req) || '',
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
