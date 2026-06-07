'use strict';

const fs = require('fs');
const path = require('path');

function lastUpdateResultPath(dataDir) {
    return path.join(dataDir, '.last_update_result.json');
}

function persistUpdateResult(dataDir, payload) {
    if (!dataDir) return null;
    const target = lastUpdateResultPath(dataDir);
    const record = {
        savedAt: new Date().toISOString(),
        ...payload,
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(record, null, 2));
    return record;
}

function readLastUpdateResult(dataDir) {
    if (!dataDir) return null;
    const target = lastUpdateResultPath(dataDir);
    if (!fs.existsSync(target)) return null;
    try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (_) {
        return null;
    }
}

module.exports = {
    lastUpdateResultPath,
    persistUpdateResult,
    readLastUpdateResult,
};
