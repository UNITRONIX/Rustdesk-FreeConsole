/**
 * BetterDesk Console — File Transfer API Routes
 *
 * REST endpoints for file transfer management and WebSocket relay.
 *
 * Endpoints:
 *
 * Admin-facing:
 *   POST   /api/files/transfer          — Initiate a file transfer
 *   GET    /api/files/transfers          — List all transfers
 *   GET    /api/files/transfers/:id      — Get transfer progress
 *   POST   /api/files/transfers/:id/cancel — Cancel a transfer
 *   GET    /api/files/transfers/:id/download — Download completed file
 *
 * Device-facing (agent):
 *   POST   /api/bd/file-transfer        — Agent initiates or sends chunks
 *   GET    /api/bd/file-transfer/:id     — Agent gets transfer info
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fileTransferService = require('../services/fileTransferService');

const { requireAuth, requirePermission } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
//  Middleware helpers
// ---------------------------------------------------------------------------

function identifyDevice(req, res, next) {
    const deviceId = req.headers['x-device-id'] || req.body?.device_id;
    if (!deviceId) {
        return res.status(400).json({ error: 'Missing device identifier' });
    }
    req.deviceId = deviceId;
    next();
}

// ---------------------------------------------------------------------------
//  Admin-facing endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/files/transfer — Initiate a file transfer
 */
router.post('/transfer', uploadLimiter, requireAuth, requirePermission('device.connect'), (req, res) => {
    try {
        const { direction, device_id, filename, size, mime_type } = req.body;

        if (!device_id || !filename) {
            return res.status(400).json({ error: 'device_id and filename are required' });
        }

        if (!direction || !['upload', 'download'].includes(direction)) {
            return res.status(400).json({ error: 'direction must be "upload" or "download"' });
        }

        const transfer = fileTransferService.createTransfer({
            direction,
            deviceId: device_id,
            filename,
            size: parseInt(size, 10) || 0,
            mimeType: mime_type || 'application/octet-stream',
            createdBy: req.session.user.username || 'admin',
        });

        res.status(201).json(transfer);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/files/transfers — List all transfers
 */
router.get('/transfers', requireAuth, requirePermission('device.connect'), (req, res) => {
    try {
        const { device_id, status, direction } = req.query;
        const transfers = fileTransferService.listTransfers({
            deviceId: device_id,
            status,
            direction,
        });
        res.json(transfers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/files/transfers/:id — Get transfer progress
 */
router.get('/transfers/:id', requireAuth, requirePermission('device.connect'), (req, res) => {
    const progress = fileTransferService.getProgress(req.params.id);
    if (!progress) {
        return res.status(404).json({ error: 'Transfer not found' });
    }
    res.json(progress);
});

/**
 * POST /api/files/transfers/:id/cancel — Cancel a transfer
 */
router.post('/transfers/:id/cancel', requireAuth, requirePermission('device.connect'), (req, res) => {
    const ok = fileTransferService.cancelTransfer(req.params.id);
    if (!ok) {
        return res.status(404).json({ error: 'Transfer not found' });
    }
    res.json({ status: 'cancelled' });
});

/**
 * GET /api/files/transfers/:id/download — Download completed file
 */
router.get('/transfers/:id/download', requireAuth, requirePermission('device.connect'), (req, res) => {
    const transfer = fileTransferService.getTransfer(req.params.id);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found' });
    }
    if (transfer.status !== 'completed') {
        return res.status(400).json({ error: 'Transfer is not completed yet' });
    }

    const filePath = fileTransferService.getCompletedFilePath(req.params.id);
    if (!filePath) {
        return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(filePath, transfer.filename, (err) => {
        if (err && !res.headersSent) {
            res.status(500).json({ error: 'Download failed' });
        }
    });
});

// ---------------------------------------------------------------------------
//  Device-facing endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/bd/file-transfer — Agent sends file transfer messages
 *
 * Body JSON with { action, transfer_id, chunk_index, data, filename, size, mime_type }
 */
router.post('/file-transfer', identifyDevice, (req, res) => {
    try {
        const result = fileTransferService.handleWsMessage(req.deviceId, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ action: 'error', error: err.message });
    }
});

/**
 * GET /api/bd/file-transfer/:id — Agent gets transfer info
 */
router.get('/file-transfer/:id', identifyDevice, (req, res) => {
    const transfer = fileTransferService.getTransfer(req.params.id);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found' });
    }
    // Only allow the device that owns the transfer
    if (transfer.deviceId !== req.deviceId) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.json(fileTransferService.getProgress(req.params.id));
});

module.exports = router;
