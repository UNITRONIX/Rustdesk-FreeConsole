/**
 * BetterDesk Console — Inventory & Telemetry API Routes
 *
 * Receives hardware/software inventory and lightweight telemetry
 * data from BetterDesk desktop agents.  Data is persisted to the
 * database via dbAdapter (SQLite or PostgreSQL).
 *
 * Endpoints:
 *   POST   /api/bd/inventory   — Full inventory upload (HW + SW)
 *   POST   /api/bd/telemetry   — Lightweight telemetry (CPU/RAM)
 *   GET    /api/bd/inventory/:id — Get last inventory for a device
 *   GET    /api/inventory       — Admin endpoint: list all device inventories
 *   GET    /api/inventory/:id   — Admin endpoint: single device inventory
 *
 * @author UNITRONIX
 * @version 2.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { getAdapter } = require('../services/dbAdapter');
const betterdeskApi = require('../services/betterdeskApi');
const { requireAuth, requirePermission } = require('../middleware/auth');

// ---------------------------------------------------------------------------
//  Helpers (shared with bd-api.routes.js)
// ---------------------------------------------------------------------------

function extractBearerToken(req) {
    const auth = req.headers['authorization'];
    const match = typeof auth === 'string' && /^Bearer\s+(\S+)$/.exec(auth);
    return match ? match[1] : null;
}

/**
 * Authenticate a device with an unrevoked, non-expired access token.
 *
 * X-Device-Id is intentionally not an authentication credential: accepting it
 * alone would let any client impersonate an enrolled device.
 */
async function requireDeviceToken(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Bearer access token required' });
    }

    let tokenRow;
    try {
        tokenRow = await db.getAccessToken(token);
    } catch (_) {
        return res.status(401).json({ error: 'Invalid or expired access token' });
    }

    if (!tokenRow || !tokenRow.client_id) {
        return res.status(401).json({ error: 'Invalid or unbound access token' });
    }

    req.deviceId = tokenRow.client_id;
    req.deviceToken = tokenRow;
    try {
        await db.touchAccessToken(token);
    } catch (_) {
        // Recording last use must not invalidate an already validated token.
    }
    return next();
}

/**
 * Require the access token to belong to the requested device before any data
 * lookup or write. This also protects against a valid token reading another
 * device's inventory.
 */
function requireTokenDeviceMatch(req, res, deviceId) {
    if (req.deviceId !== deviceId) {
        res.status(403).json({ success: false, error: 'Device ID mismatch' });
        return false;
    }
    return true;
}

function parsePagination(req) {
    const parsePositiveInteger = (value, fallback, max) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
        return Math.min(parsed, max);
    };

    const page = parsePositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInteger(req.query.limit, 50, 100);
    if (!page || !limit) return null;
    return { page, limit };
}

// ---------------------------------------------------------------------------
//  Device-facing endpoints (authenticated via device-bound access token)
// ---------------------------------------------------------------------------

/**
 * POST /api/bd/inventory — Full inventory upload (HW + SW).
 *
 * Body: { device_id, hardware: {...}, software: {...}, collected_at }
 */
router.post('/inventory', requireDeviceToken, async (req, res) => {
    try {
        const { device_id, hardware, software, collected_at } = req.body;

        if (!device_id || !hardware) {
            return res.status(400).json({ success: false, error: 'Missing device_id or hardware' });
        }

        // Validate that the authenticated device matches
        if (!requireTokenDeviceMatch(req, res, device_id)) return;

        // Persist to database
        const adapter = getAdapter();
        await adapter.upsertInventory(device_id, hardware, software, collected_at);

        // Also update peer info in main database if peer exists
        try {
            const peer = await db.getPeerById(device_id);
            if (peer) {
                const info = {
                    ...(peer.info ? JSON.parse(peer.info) : {}),
                    hostname: hardware.hostname || undefined,
                    os: hardware.os_name || undefined,
                    os_version: hardware.os_version || undefined,
                    cpu: hardware.cpu?.brand || undefined,
                    cpu_cores: hardware.cpu?.logical_cores || undefined,
                    memory_mb: hardware.memory?.total_bytes
                        ? Math.round(hardware.memory.total_bytes / 1048576)
                        : undefined,
                };
                await db.updatePeer(device_id, { info: JSON.stringify(info) });
            }
        } catch (dbErr) {
            console.warn('[Inventory] Failed to update peer info:', dbErr.message);
        }

        console.log(`[Inventory] Full inventory received from ${device_id} (HW + ${software?.apps?.length || 0} apps)`);

        res.json({ success: true });
    } catch (err) {
        console.error('[Inventory] Upload error:', err.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /api/bd/telemetry — Lightweight telemetry (CPU/RAM/uptime).
 *
 * Body: { device_id, cpu_usage_percent, memory_used_bytes, memory_total_bytes, uptime_secs, timestamp }
 */
router.post('/telemetry', requireDeviceToken, async (req, res) => {
    try {
        const {
            device_id,
            cpu_usage_percent,
            memory_used_bytes,
            memory_total_bytes,
            uptime_secs,
            timestamp,
        } = req.body;

        if (!device_id) {
            return res.status(400).json({ success: false, error: 'Missing device_id' });
        }

        if (!requireTokenDeviceMatch(req, res, device_id)) return;

        const adapter = getAdapter();
        await adapter.upsertTelemetry(device_id, {
            cpu_usage_percent: cpu_usage_percent ?? 0,
            memory_used_bytes: memory_used_bytes ?? 0,
            memory_total_bytes: memory_total_bytes ?? 0,
            uptime_secs: uptime_secs ?? 0,
            timestamp: timestamp || new Date().toISOString(),
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[Telemetry] Upload error:', err.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/bd/inventory/:id — Get last inventory for a specific device.
 * Accessible by the device itself (via token) or by admin.
 */
router.get('/inventory/:id', requireDeviceToken, async (req, res) => {
    try {
        const deviceId = req.params.id;
        if (!requireTokenDeviceMatch(req, res, deviceId)) return;
        const adapter = getAdapter();
        const entry = await adapter.getInventory(deviceId);

        if (!entry) {
            return res.status(404).json({ error: 'No inventory data for this device' });
        }

        res.json(entry);
    } catch (err) {
        console.error('[Inventory] Get error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Admin-facing endpoints (web console)
// ---------------------------------------------------------------------------

/**
 * GET /api/inventory — List all device inventories (admin only).
 */
router.get('/', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const pagination = parsePagination(req);
        if (!pagination) {
            return res.status(400).json({ error: 'Invalid pagination parameters' });
        }

        const adapter = getAdapter();
        const inventories = await adapter.getAllInventories();
        let devices = [];

        if (inventories.length > 0) {
            // Inventory includes the most recent collected hardware data. Do
            // not issue a per-device telemetry query here: that was an N+1
            // database pattern on this list endpoint.
            devices = inventories.map(inv => ({
                device_id: inv.device_id,
                hostname: inv.hardware?.hostname || inv.device_id,
                os: `${inv.hardware?.os_name || ''} ${inv.hardware?.os_version || ''}`.trim(),
                cpu: inv.hardware?.cpu?.brand || 'Unknown',
                cpu_cores: inv.hardware?.cpu?.logical_cores || 0,
                cpu_usage: inv.hardware?.cpu?.usage_percent ?? null,
                memory_total_mb: inv.hardware?.memory?.total_bytes
                    ? Math.round(inv.hardware.memory.total_bytes / 1048576)
                    : 0,
                memory_used_mb: inv.hardware?.memory?.used_bytes
                    ? Math.round(inv.hardware.memory.used_bytes / 1048576)
                    : 0,
                disk_count: inv.hardware?.disks?.length || 0,
                software_count: inv.software?.apps?.length || 0,
                last_seen: inv.received_at,
                collected_at: inv.collected_at,
            }));
        } else {
            // Fallback: populate from Go server peer list when no agent inventory exists
            try {
                const peers = await betterdeskApi.getAllPeers();
                const peerList = Array.isArray(peers) ? peers : (peers?.data || []);
                devices = peerList.map(p => ({
                    device_id: p.id,
                    hostname: p.hostname || p.id,
                    os: p.platform || p.os || '',
                    cpu: '',
                    cpu_cores: 0,
                    cpu_usage: null,
                    memory_total_mb: 0,
                    memory_used_mb: 0,
                    disk_count: 0,
                    software_count: 0,
                    last_seen: p.last_online || null,
                    collected_at: null,
                    source: 'peer_list',
                }));
            } catch (fallbackErr) {
                console.warn('[Inventory] Peer list fallback failed:', fallbackErr.message);
            }
        }

        const total = devices.length;
        const totalPages = Math.ceil(total / pagination.limit);
        // Avoid multiplying an unbounded client-supplied page value.
        const start = pagination.page > totalPages
            ? total
            : (pagination.page - 1) * pagination.limit;
        const pagedDevices = devices.slice(start, start + pagination.limit);

        res.json({
            devices: pagedDevices,
            total,
            page: pagination.page,
            limit: pagination.limit,
            total_pages: totalPages,
        });
    } catch (err) {
        console.error('[Inventory] List error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/inventory/:id — Full inventory detail for one device (admin only).
 */
router.get('/:id', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const deviceId = req.params.id;
        const adapter = getAdapter();
        const inv = await adapter.getInventory(deviceId);
        const telemetry = await adapter.getTelemetry(deviceId);

        if (!inv) {
            return res.status(404).json({ error: 'No inventory data for this device' });
        }

        res.json({
            ...inv,
            telemetry,
        });
    } catch (err) {
        console.error('[Inventory] Detail error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
