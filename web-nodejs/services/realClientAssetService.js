'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const config = require('../config/config');

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const KINDS = new Set(['icon', 'logo', 'privacy']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const root = path.resolve(config.dataDir, 'real-client-assets');

function assertKind(kind) {
    if (!KINDS.has(kind)) throw Object.assign(new Error('Unsupported asset kind'), { statusCode: 400 });
}

function ownerDir(ownerUserId) {
    const owner = Number(ownerUserId);
    if (!Number.isSafeInteger(owner) || owner <= 0) throw Object.assign(new Error('Invalid asset owner'), { statusCode: 400 });
    return path.join(root, `user-${owner}`);
}

function validatePng(buffer, kind) {
    assertKind(kind);
    if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_ASSET_BYTES) {
        throw Object.assign(new Error(`PNG asset must be between 24 bytes and ${MAX_ASSET_BYTES} bytes`), { statusCode: 400 });
    }
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw Object.assign(new Error('Only valid PNG images are accepted'), { statusCode: 400 });
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096) {
        throw Object.assign(new Error('PNG dimensions are invalid or exceed 4096 x 4096'), { statusCode: 400 });
    }
    try {
        const decoded = PNG.sync.read(buffer, { checkCRC: true, skipRescale: true });
        if (decoded.width !== width || decoded.height !== height) throw new Error('dimension mismatch');
    } catch (_) {
        throw Object.assign(new Error('PNG data is corrupt or failed integrity validation'), { statusCode: 400 });
    }
    if (kind === 'icon' && width !== height) {
        throw Object.assign(new Error('Application icon must be square'), { statusCode: 400 });
    }
    return { width, height };
}

async function saveAsset({ ownerUserId, kind, buffer, originalName = '' }) {
    const dimensions = validatePng(buffer, kind);
    const id = crypto.randomUUID();
    const dir = ownerDir(ownerUserId);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${id}.${kind}.png`);
    const handle = await fs.promises.open(filePath, 'wx', 0o600);
    try {
        await handle.writeFile(buffer);
    } finally {
        await handle.close();
    }
    return {
        id,
        kind,
        originalName: String(originalName || '').slice(0, 255),
        size: buffer.length,
        ...dimensions,
    };
}

async function readAsset({ ownerUserId, id, kind }) {
    assertKind(kind);
    if (!UUID.test(String(id || ''))) {
        throw Object.assign(new Error('Invalid asset reference'), { statusCode: 400 });
    }
    const filePath = path.join(ownerDir(ownerUserId), `${id}.${kind}.png`);
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid asset path');
    const buffer = await fs.promises.readFile(filePath);
    validatePng(buffer, kind);
    return { path: filePath, buffer, mime: 'image/png' };
}

async function collectAssets(ownerUserId, references = {}) {
    const output = {};
    for (const kind of KINDS) {
        const id = references[kind];
        if (!id) continue;
        const asset = await readAsset({ ownerUserId, id, kind });
        output[kind] = {
            id,
            mime: asset.mime,
            data: asset.buffer.toString('base64'),
        };
    }
    return output;
}

async function cleanupOrphans(referencedIds, minimumAgeMs = 24 * 60 * 60 * 1000) {
    const keep = referencedIds instanceof Set ? referencedIds : new Set(referencedIds || []);
    let ownerDirs = [];
    try { ownerDirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
    let removed = 0;
    const now = Date.now();
    for (const ownerEntry of ownerDirs) {
        if (!ownerEntry.isDirectory() || !/^user-\d+$/.test(ownerEntry.name)) continue;
        const dir = path.join(root, ownerEntry.name);
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of files) {
            if (!entry.isFile()) continue;
            const match = entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(icon|logo|privacy)\.png$/i);
            if (!match || keep.has(match[1])) continue;
            const filePath = path.join(dir, entry.name);
            const stat = await fs.promises.stat(filePath);
            if (now - stat.mtimeMs < minimumAgeMs) continue;
            await fs.promises.unlink(filePath);
            removed++;
        }
        await fs.promises.rmdir(dir).catch(() => {});
    }
    return removed;
}

module.exports = {
    MAX_ASSET_BYTES,
    KINDS,
    validatePng,
    saveAsset,
    readAsset,
    collectAssets,
    cleanupOrphans,
};
