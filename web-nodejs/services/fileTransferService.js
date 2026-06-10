/**
 * BetterDesk Console — File Transfer Relay Service
 *
 * Relays file transfer chunks between admin console and desktop
 * agents via WebSocket.  Also provides REST endpoints for
 * browse / metadata operations and tracks active transfers.
 *
 * Protocol flow:
 *   1. Admin initiates transfer (upload/download) via REST
 *   2. Server creates a transfer record and notifies the agent via WS
 *   3. Agent streams chunks through WS or REST
 *   4. Server relays chunks to the other party
 *   5. Transfer is marked complete when all chunks are received
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { resolveChildPath } = require('../lib/safePath');

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

const TRANSFER_DIR = path.join(__dirname, '..', 'data', 'transfers');
const MAX_CHUNK_SIZE = 256 * 1024; // 256 KB
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

if (!fs.existsSync(TRANSFER_DIR)) {
    fs.mkdirSync(TRANSFER_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
//  In-memory transfer registry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TransferRecord
 * @property {string} id
 * @property {string} direction    - 'upload' (admin→agent) or 'download' (agent→admin)
 * @property {string} deviceId
 * @property {string} filename
 * @property {number} size
 * @property {string} mimeType
 * @property {string} status       - 'pending'|'active'|'completed'|'failed'|'cancelled'
 * @property {number} bytesTransferred
 * @property {number} totalChunks
 * @property {number} chunksReceived
 * @property {string} tempPath
 * @property {string} createdBy
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @type {Map<string, TransferRecord>} */
const transfers = new Map();

// ---------------------------------------------------------------------------
//  Cleanup timer — remove stale transfers
// ---------------------------------------------------------------------------

setInterval(() => {
    const now = Date.now();
    for (const [id, t] of transfers) {
        if (t.status === 'active' && now - t.updatedAt > TRANSFER_TIMEOUT_MS) {
            t.status = 'failed';
            console.warn(`[FileTransfer] Transfer ${id} timed out`);
            cleanupTempFile(t.tempPath);
        }
        // Remove completed/failed transfers after 1 hour
        if ((t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') &&
            now - t.updatedAt > 3600000) {
            transfers.delete(id);
        }
    }
}, 60000);

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Initiate a new file transfer.
 */
function createTransfer({ direction, deviceId, filename, size, mimeType, createdBy }) {
    if (size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const id = crypto.randomBytes(16).toString('hex');
    const safeName = path.basename(String(filename || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const tempPath = resolveChildPath(TRANSFER_DIR, `${id}_${safeName}`);
    const totalChunks = Math.ceil(size / MAX_CHUNK_SIZE) || 1;

    const record = {
        id,
        direction: direction || 'download',
        deviceId,
        filename: safeName,
        size: size || 0,
        mimeType: mimeType || 'application/octet-stream',
        status: 'pending',
        bytesTransferred: 0,
        totalChunks,
        chunksReceived: 0,
        tempPath,
        createdBy: createdBy || 'system',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    transfers.set(id, record);
    console.log(`[FileTransfer] Created transfer ${id}: ${direction} ${safeName} (${size} bytes) for ${deviceId}`);
    return record;
}

/**
 * Get a transfer by ID.
 */
function getTransfer(id) {
    return transfers.get(id) || null;
}

/**
 * List all transfers, optionally filtered.
 */
function listTransfers({ deviceId, status, direction } = {}) {
    let result = Array.from(transfers.values());
    if (deviceId) result = result.filter(t => t.deviceId === deviceId);
    if (status) result = result.filter(t => t.status === status);
    if (direction) result = result.filter(t => t.direction === direction);
    return result.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Receive a chunk of data for a transfer.
 */
function receiveChunk(transferId, chunkIndex, data) {
    const t = transfers.get(transferId);
    if (!t) throw new Error('Transfer not found');
    if (t.status === 'cancelled' || t.status === 'failed') {
        throw new Error(`Transfer is ${t.status}`);
    }

    if (t.status === 'pending') t.status = 'active';

    // Write chunk to temp file
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    const fd = fs.openSync(t.tempPath, chunkIndex === 0 ? 'w' : 'a');
    fs.writeSync(fd, buffer);
    fs.closeSync(fd);

    t.bytesTransferred += buffer.length;
    t.chunksReceived++;
    t.updatedAt = Date.now();

    // Check completion
    if (t.bytesTransferred >= t.size) {
        t.status = 'completed';
        console.log(`[FileTransfer] Transfer ${transferId} completed: ${t.bytesTransferred} bytes`);
    }

    return {
        transferId,
        chunksReceived: t.chunksReceived,
        totalChunks: t.totalChunks,
        bytesTransferred: t.bytesTransferred,
        totalBytes: t.size,
        percent: (t.bytesTransferred / Math.max(t.size, 1)) * 100,
        status: t.status,
    };
}

/**
 * Cancel a transfer.
 */
function cancelTransfer(transferId) {
    const t = transfers.get(transferId);
    if (!t) return false;
    t.status = 'cancelled';
    t.updatedAt = Date.now();
    cleanupTempFile(t.tempPath);
    console.log(`[FileTransfer] Transfer ${transferId} cancelled`);
    return true;
}

/**
 * Get progress for a transfer.
 */
function getProgress(transferId) {
    const t = transfers.get(transferId);
    if (!t) return null;
    return {
        transferId: t.id,
        status: t.status,
        bytesTransferred: t.bytesTransferred,
        totalBytes: t.size,
        chunksReceived: t.chunksReceived,
        totalChunks: t.totalChunks,
        percent: (t.bytesTransferred / Math.max(t.size, 1)) * 100,
        filename: t.filename,
        direction: t.direction,
    };
}

/**
 * Get the path of a completed transfer file for download.
 */
function getCompletedFilePath(transferId) {
    const t = transfers.get(transferId);
    if (!t || t.status !== 'completed') return null;
    if (!fs.existsSync(t.tempPath)) return null;
    return t.tempPath;
}

/**
 * Handle WebSocket file transfer messages.
 * Called by the relay service when a WS message with type 'file_transfer' arrives.
 */
function handleWsMessage(deviceId, message) {
    try {
        const { action, transfer_id, chunk_index, data, filename, size, mime_type } = message;

        switch (action) {
            case 'init': {
                // Agent initiates a new download transfer
                const t = createTransfer({
                    direction: 'download',
                    deviceId,
                    filename: filename || 'unknown',
                    size: size || 0,
                    mimeType: mime_type || 'application/octet-stream',
                    createdBy: `agent:${deviceId}`,
                });
                return { action: 'init_ack', transfer_id: t.id, status: 'ok' };
            }

            case 'chunk': {
                const progress = receiveChunk(transfer_id, chunk_index || 0, data);
                return { action: 'chunk_ack', ...progress };
            }

            case 'cancel': {
                cancelTransfer(transfer_id);
                return { action: 'cancel_ack', transfer_id };
            }

            case 'browse': {
                // Forwarded to the agent — not handled server-side
                return { action: 'browse_forward', deviceId, path: message.path };
            }

            default:
                return { action: 'error', error: `Unknown action: ${action}` };
        }
    } catch (err) {
        return { action: 'error', error: err.message };
    }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function cleanupTempFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }
}

module.exports = {
    createTransfer,
    getTransfer,
    listTransfers,
    receiveChunk,
    cancelTransfer,
    getProgress,
    getCompletedFilePath,
    handleWsMessage,
    MAX_FILE_SIZE,
    MAX_CHUNK_SIZE,
};
