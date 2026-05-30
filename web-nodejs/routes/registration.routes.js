/**
 * BetterDesk Console — Registration Requests Routes
 *
 * Handles LAN discovery registration workflow:
 *
 * Device-facing (no session auth — requests come from desktop clients):
 *   POST   /api/bd/register-request   — Submit a new registration request
 *   GET    /api/bd/register-status     — Poll approval status (by device_id)
 *
 * Admin-facing (session auth required):
 *   GET    /registrations              — Registrations page (EJS)
 *   GET    /api/registrations          — List all registration requests
 *   GET    /api/registrations/count    — Pending count (for sidebar badge)
 *   GET    /api/registrations/:id      — Single registration detail
 *   PUT    /api/registrations/:id/approve — Approve a pending request
 *   PUT    /api/registrations/:id/reject  — Reject a pending request
 *   DELETE /api/registrations/:id      — Delete a registration record
 *
 * @module routes/registration.routes
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const db = require('../services/database');
const config = require('../config/config');
const { requirePermission } = require('../middleware/auth');
const betterdeskApi = require('../services/betterdeskApi');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

/**
 * Read the server public key from disk (base64).
 */
function getServerPublicKey() {
    try {
        if (fs.existsSync(config.pubKeyPath)) {
            return fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        }
    } catch (_) { /* ignore */ }
    return '';
}

/**
 * Generate a device access token for a newly approved device.
 */
function generateDeviceAccessToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Build the server config payload returned to devices upon approval.
 */
function buildServerConfig() {
    const protocol = config.httpsEnabled ? 'https' : 'http';
    const consoleUrl = `${protocol}://0.0.0.0:${config.port}`;

    return {
        console_url: consoleUrl,
        server_address: `0.0.0.0:21116`,
        server_key: getServerPublicKey(),
        access_token: generateDeviceAccessToken(),
    };
}

// ===========================================================================
//  Device-facing endpoints (no session auth — CSRF-exempt via /api/bd prefix)
// ===========================================================================

/**
 * POST /api/bd/register-request
 * Body: { device_id, hostname, platform, version, public_key?, uuid? }
 *
 * Called by the desktop client after LAN discovery to request pairing.
 */
router.post('/register-request', async (req, res) => {
    try {
        const { device_id, hostname, platform, version, public_key, uuid } = req.body || {};

        if (!device_id || typeof device_id !== 'string' || device_id.length < 3) {
            return res.status(400).json({ success: false, error: 'Invalid device_id' });
        }

        const ipAddress = getClientIp(req);

        const registration = await db.createPendingRegistration({
            device_id: device_id.trim(),
            hostname: (hostname || '').substring(0, 255),
            platform: (platform || '').substring(0, 64),
            version: (version || '').substring(0, 32),
            ip_address: ipAddress,
            public_key: (public_key || '').substring(0, 512),
            uuid: (uuid || '').substring(0, 64),
        });

        res.json({
            success: true,
            status: registration.status,
            id: registration.id,
        });
    } catch (err) {
        console.error('Register request error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/bd/register-status?device_id=XXXX
 *
 * Polled by the desktop client to check if its registration was approved.
 * Returns the full server config when approved.
 */
router.get('/register-status', async (req, res) => {
    try {
        const deviceId = req.query.device_id;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'Missing device_id' });
        }

        const reg = await db.getPendingRegistrationByDeviceId(deviceId);
        if (!reg) {
            return res.json({ success: true, status: 'not_found' });
        }

        const response = {
            success: true,
            status: reg.status,
            id: reg.id,
        };

        // When approved, include the server configuration so the client can
        // auto-configure without manual input.
        if (reg.status === 'approved') {
            response.config = {
                console_url: reg.console_url || '',
                server_address: reg.server_address || '',
                server_key: reg.server_key || '',
                access_token: reg.access_token || '',
            };
        }

        if (reg.status === 'rejected') {
            response.reason = reg.rejected_reason || '';
        }

        res.json(response);
    } catch (err) {
        console.error('Register status error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===========================================================================
//  Admin-facing endpoints (session auth required)
// ===========================================================================

/**
 * GET /registrations — Render the registrations management page.
 */
router.get('/registrations', requirePermission('enrollment.approve'), (req, res) => {
    res.render('registrations', {
        title: req.t('nav.registrations'),
        activePage: 'registrations',
    });
});

/**
 * GET /api/registrations — List all registration requests.
 * Query: ?status=pending|approved|rejected  &search=xxx
 */
router.get('/api/registrations', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const filters = {
            status: req.query.status || '',
            search: req.query.search || '',
        };
        const registrations = await db.getPendingRegistrations(filters);

        res.json({
            success: true,
            data: registrations,
            total: registrations.length,
        });
    } catch (err) {
        console.error('Get registrations error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/registrations/count — Pending registration count (sidebar badge).
 */
router.get('/api/registrations/count', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const count = await db.getPendingRegistrationCount();
        res.json({ success: true, count });
    } catch (err) {
        res.json({ success: true, count: 0 });
    }
});

/**
 * GET /api/registrations/:id — Single registration detail.
 */
router.get('/api/registrations/:id', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const reg = await db.getPendingRegistrationById(parseInt(req.params.id, 10));
        if (!reg) {
            return res.status(404).json({ success: false, error: 'Registration not found' });
        }
        res.json({ success: true, data: reg });
    } catch (err) {
        console.error('Get registration error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/registrations/:id/approve — Approve a pending registration.
 *
 * On approval, generates an access token and server config that the client
 * can retrieve via the polling endpoint.
 */
router.put('/api/registrations/:id/approve', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reg = await db.getPendingRegistrationById(id);
        if (!reg) {
            return res.status(404).json({ success: false, error: 'Registration not found' });
        }
        if (reg.status !== 'pending') {
            return res.status(400).json({ success: false, error: `Cannot approve: status is ${reg.status}` });
        }

        // Build server config — use actual server address from the request
        const serverConfig = buildServerConfig();

        // Replace 0.0.0.0 with the actual hostname / IP the admin is accessing
        const actualHost = req.headers.host?.split(':')[0] || req.hostname || 'localhost';
        serverConfig.console_url = serverConfig.console_url.replace('0.0.0.0', actualHost);
        serverConfig.server_address = serverConfig.server_address.replace('0.0.0.0', actualHost);

        const username = req.session?.user?.username || 'admin';
        const updated = await db.approvePendingRegistration(id, username, serverConfig);

        // Log the approval
        try {
            await db.logAction(
                req.session?.user?.id || 0,
                'registration_approved',
                `Approved registration for device ${reg.device_id} (${reg.hostname})`,
                getClientIp(req)
            );
        } catch (_) { /* audit log optional */ }

        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('Approve registration error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/registrations/:id/reject — Reject a pending registration.
 * Body: { reason?: string }
 */
router.put('/api/registrations/:id/reject', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reason = (req.body?.reason || '').substring(0, 500);

        const reg = await db.getPendingRegistrationById(id);
        if (!reg) {
            return res.status(404).json({ success: false, error: 'Registration not found' });
        }
        if (reg.status !== 'pending') {
            return res.status(400).json({ success: false, error: `Cannot reject: status is ${reg.status}` });
        }

        const updated = await db.rejectPendingRegistration(id, reason);

        // Log the rejection
        try {
            await db.logAction(
                req.session?.user?.id || 0,
                'registration_rejected',
                `Rejected registration for device ${reg.device_id} (${reg.hostname}): ${reason}`,
                getClientIp(req)
            );
        } catch (_) { /* audit log optional */ }

        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('Reject registration error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * DELETE /api/registrations/:id — Delete a registration record.
 */
router.delete('/api/registrations/:id', requirePermission('enrollment.manage'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reg = await db.getPendingRegistrationById(id);
        if (!reg) {
            return res.status(404).json({ success: false, error: 'Registration not found' });
        }
        await db.deletePendingRegistration(id);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete registration error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ===========================================================================
//  Go Server Enrollment Proxy — pending devices managed by Go server
// ===========================================================================

/**
 * GET /api/enrollment/pending — List pending enrollment requests from Go server.
 */
router.get('/api/enrollment/pending', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const result = await betterdeskApi.getEnrollmentPending();
        res.json(result);
    } catch (err) {
        console.error('Get enrollment pending error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/enrollment/approve/:id — Approve a pending enrollment on Go server.
 * Body: { display_name, sync_mode, tags, folder_id }
 */
router.post('/api/enrollment/approve/:id', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const deviceId = req.params.id;
        const { display_name, sync_mode, tags, folder_id } = req.body;
        const result = await betterdeskApi.approveEnrollment(deviceId, display_name, sync_mode, tags);

        if (result.success) {
            // Folders are managed Node-side; assign after Go approval succeeds.
            const folderId = parseInt(folder_id, 10);
            if (!isNaN(folderId) && folderId > 0) {
                try {
                    await db.assignDeviceToFolder(deviceId, folderId);
                } catch (e) {
                    console.error('Assign device to folder error:', e);
                }
            }
            try {
                await db.logAction(
                    req.session?.user?.id || 0,
                    'enrollment_approved',
                    `Approved enrollment for device ${deviceId} (mode: ${sync_mode || 'standard'})`,
                    getClientIp(req)
                );
            } catch (_) { /* audit log optional */ }
        }

        res.json(result);
    } catch (err) {
        console.error('Approve enrollment error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/enrollment/reject/:id — Reject a pending enrollment on Go server.
 * Body: { ban }
 */
router.post('/api/enrollment/reject/:id', requirePermission('enrollment.approve'), async (req, res) => {
    try {
        const deviceId = req.params.id;
        const ban = !!(req.body && req.body.ban);
        const result = await betterdeskApi.rejectEnrollment(deviceId, ban);

        if (result.success) {
            try {
                await db.logAction(
                    req.session?.user?.id || 0,
                    'enrollment_rejected',
                    `Rejected enrollment for device ${deviceId}${ban ? ' (banned)' : ''}`,
                    getClientIp(req)
                );
            } catch (_) { /* audit log optional */ }
        }

        res.json(result);
    } catch (err) {
        console.error('Reject enrollment error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

module.exports = router;
