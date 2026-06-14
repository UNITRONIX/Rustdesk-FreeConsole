/**
 * BetterDesk Console - Remote Desktop Routes
 * Serves the web-based remote desktop viewer page (RustDesk compat + BetterDesk native)
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../services/database');
const config = require('../config/config');
const { requireRdClientAuth, rdClientGuestOnly, isSafeRdClientReturnUrl } = require('../middleware/auth');

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
router.get('/remote/login', rdClientGuestOnly, (req, res) => {
    const returnUrl = isSafeRdClientReturnUrl(req.query.return) ? req.query.return : '/remote';
    const sessionExpired = req.query.expired === '1' || req.query.expired === 'true';
    res.render('rdclient-login', {
        title: req.t('rdclient_login.title'),
        activePage: 'remote',
        returnUrl,
        sessionExpired,
    });
});

/**
 * GET /remote - RdClient operator dashboard (device list + connect)
 */
router.get('/remote', requireRdClientAuth('device.connect'), (req, res) => {
    res.render('remote-dashboard', {
        title: req.t('remote_dashboard.title'),
        activePage: 'remote',
    });
});

/**
 * GET /remote/:deviceId - Unified remote desktop viewer (single entry point).
 */
router.get('/remote/:deviceId', requireRdClientAuth('device.connect'), async (req, res) => {
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
    let goPeer = null;
    try {
        const api = require('../services/betterdeskApi');
        goPeer = await api.getPeer(deviceId);
        if (goPeer) {
            isOsAgent = String(goPeer.device_type || '').toLowerCase() === 'os_agent';
            isCdapConnected = !!goPeer.cdap_connected;
        }
    } catch { /* non-fatal: degrade to standard viewer */ }

    const forced = String(req.query.transport || '').toLowerCase();
    let transport;
    if (forced === 'cdap' || forced === 'rd') {
        transport = forced;
    } else if (isOsAgent || isCdapConnected) {
        transport = 'cdap';
    } else {
        transport = 'rd';
    }

    const capabilities = {
        transport,
        os_agent: isOsAgent,
        cdap_connected: isCdapConnected,
        device_type: goPeer && goPeer.device_type ? String(goPeer.device_type) : '',
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
router.get('/remote-cdap/:deviceId', requireRdClientAuth('device.connect'), (req, res) => {
    const deviceId = req.params.deviceId;
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect(`/remote/${encodeURIComponent(deviceId)}?transport=cdap`);
    }
    return res.redirect('/devices');
});

/**
 * GET /remote-desktop/:deviceId - Legacy route, redirects to unified /remote/:deviceId
 */
router.get('/remote-desktop/:deviceId', requireRdClientAuth('device.connect'), (req, res) => {
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
