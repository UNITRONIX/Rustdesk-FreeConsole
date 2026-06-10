'use strict';

const fs = require('fs');
const path = require('path');
const { splitUpdateFailures } = require('./updateFailurePolicy');

function lastUpdateResultPath(dataDir) {
    return path.join(dataDir, '.last_update_result.json');
}

function shaMatches(a, b) {
    if (!a || !b) return false;
    const left = String(a).trim().toLowerCase();
    const right = String(b).trim().toLowerCase();
    if (!left || !right) return false;
    return left === right
        || left.startsWith(right.slice(0, 7))
        || right.startsWith(left.slice(0, 7));
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

function clearLastUpdateResult(dataDir) {
    if (!dataDir) return false;
    const target = lastUpdateResultPath(dataDir);
    if (!fs.existsSync(target)) return false;
    try {
        fs.unlinkSync(target);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Drop stale or non-actionable update warnings from the persisted panel result.
 * Returns null when nothing should be shown in Settings → Updates.
 *
 * @param {string} dataDir
 * @param {{ rootDir?: string, localSHA?: string|null, remoteSHA?: string|null }} [opts]
 * @returns {object|null}
 */
function resolveLastUpdateResultForDisplay(dataDir, opts = {}) {
    const record = readLastUpdateResult(dataDir);
    if (!record) return null;

    const rootDir = opts.rootDir || null;
    const localSHA = opts.localSHA || null;
    const remoteSHA = opts.remoteSHA || null;

    const { critical, nonCritical } = splitUpdateFailures(record.failed || [], rootDir);
    const hasServiceFailures = Array.isArray(record.servicesFailed) && record.servicesFailed.length > 0;
    const hasRestartBlock = !!record.consoleRestartBlocked;

    // Target commit reached via script / external update — clear stale panel log (#192).
    if (localSHA && record.sha && shaMatches(localSHA, record.sha)) {
        clearLastUpdateResult(dataDir);
        return null;
    }

    // Already at remote HEAD while the stored record targets an older commit.
    if (localSHA && remoteSHA && shaMatches(localSHA, remoteSHA)
        && record.sha && !shaMatches(record.sha, remoteSHA)) {
        clearLastUpdateResult(dataDir);
        return null;
    }

    if (critical.length === 0 && !hasServiceFailures && !hasRestartBlock) {
        if ((record.failed || []).length > 0 || nonCritical.length > 0) {
            clearLastUpdateResult(dataDir);
        }
        return null;
    }

    return {
        ...record,
        failed: critical,
        nonCriticalFailures: nonCritical,
    };
}

module.exports = {
    lastUpdateResultPath,
    persistUpdateResult,
    readLastUpdateResult,
    clearLastUpdateResult,
    resolveLastUpdateResultForDisplay,
    shaMatches,
};
