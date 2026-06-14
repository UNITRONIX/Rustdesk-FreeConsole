/**
 * BetterDesk Console - Remote Desktop Routes
 * Serves the web-based remote desktop viewer page (RustDesk compat + BetterDesk native)
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../services/database');
const config = require('../config/config');
const { requireAuth, requirePermission } = require('../middleware/auth');

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
 * GET /remote - RdClient operator dashboard (device list + connect)
 */
router.get('/remote', requireAuth, requirePermission('device.connect'), (req, res) => {
    res.render('remote-dashboard', {
        title: req.t('remote_dashboard.title'),
        activePage: 'remote',
    });
});

/**
 * GET /remote/:deviceId - Unified remote desktop viewer (single entry point).
 *
 * Phase 2.1 of the unification plan: this route is now the only canonical
 * URL for browser-based remote desktop. The transport (RustDesk relay vs.
 * CDAP WebSocket) is auto-detected on the server by probing the Go server
 * for `device_type` and `cdap_connected`. The decision is then passed to
 * the appropriate template.
 *
 * Query overrides:
 *   ?transport=cdap   → force CDAP transport (skip auto-probe)
 *   ?transport=rd     → force RustDesk transport
 *
 * Until the unified `remote.ejs` shell lands (PR 2.2 / 2.3) we still render
 * the existing two templates underneath. Operators get a single URL and
 * shareable links work regardless of which transport is active.
 */
router.get('/remote/:deviceId', requireAuth, async (req, res) => {
    const deviceId = req.params.deviceId;

    if (!deviceId || !/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect('/devices');
    }

    let device = null;
    try {
        device = await db.getDevice(deviceId);
    } catch {
        // Database lookup failure is non-blocking - viewer can still work
    }

    // Probe Go server for authoritative transport hint. Local panel DB
    // does not carry `device_type` or `cdap_connected`.
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

    // Resolve transport: explicit query param wins, then auto-detect.
    const forced = String(req.query.transport || '').toLowerCase();
    let transport;
    if (forced === 'cdap' || forced === 'rd') {
        transport = forced;
    } else if (isOsAgent || isCdapConnected) {
        transport = 'cdap';
    } else {
        transport = 'rd';
    }

    // Capability hints exposed to the browser so the unified UI can light
    // up the right toolbar buttons.
    const capabilities = {
        transport,
        os_agent: isOsAgent,
        cdap_connected: isCdapConnected,
        device_type: goPeer && goPeer.device_type ? String(goPeer.device_type) : '',
    };

    // PR 2.2/2.3 unification: a single canonical web client (`remote.ejs`)
    // serves both transports. The browser branches on
    // `window.__capabilities.transport`. The legacy `remote-cdap` template
    // is no longer rendered; its inline widget remains usable from
    // device-detail panels via `cdap-desktop.js` directly.
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
 *
 * Kept for backwards compatibility with existing bookmarks, deep links, and
 * the `devices.js` "Connect" button. New code should link to
 * `/remote/:deviceId` directly.
 */
router.get('/remote-cdap/:deviceId', requireAuth, (req, res) => {
    const deviceId = req.params.deviceId;
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect(`/remote/${encodeURIComponent(deviceId)}?transport=cdap`);
    }
    return res.redirect('/devices');
});

/**
 * GET /remote-desktop/:deviceId - Legacy route, redirects to unified /remote/:deviceId
 *
 * Previously served a separate JPEG stream viewer. The web remote client has
 * been unified: `/remote/:deviceId` is now the only canonical entry point for
 * browser-based remote desktop.
 */
router.get('/remote-desktop/:deviceId', requireAuth, (req, res) => {
    const deviceId = req.params.deviceId;
    if (deviceId && /^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        return res.redirect(`/remote/${encodeURIComponent(deviceId)}`);
    }
    return res.redirect('/devices');
});

/**
 * GET /api/remote/sessions - List active native remote sessions
 */
router.get('/api/remote/sessions', requireAuth, (req, res) => {
    const relay = getRemoteRelay();
    if (!relay) return res.json({ sessions: [] });
    const sessions = relay.getActiveSessions();
    res.json({ sessions });
});

/**
 * GET /api/remote/session/:deviceId - Get state of a single native remote session
 */
router.get('/api/remote/session/:deviceId', requireAuth, (req, res) => {
    const relay = getRemoteRelay();
    if (!relay) return res.status(404).json({ error: 'Remote relay not available' });
    const state = relay.getSessionState(req.params.deviceId);
    if (!state) return res.status(404).json({ error: 'Session not found' });
    res.json(state);
});

module.exports = router;
