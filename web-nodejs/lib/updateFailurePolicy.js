'use strict';

const fs = require('fs');
const path = require('path');

const NON_CRITICAL_UPDATE_FAILURES = new Set([
    'betterdesk-server',
    'betterdesk-server-deploy',
    'betterdesk-server.service',
    'server-source',
    'npm install',
    'support-agent-source-sync',
    'support-agent-rebuild-defer',
    // Installer / Docker root files — optional beside the console; EACCES/EPERM
    // on these must not block SHA save (Windows drive-root bug #272, Linux root-owned /opt).
    'betterdesk.sh',
    'betterdesk.ps1',
    'betterdesk-docker.sh',
    'docker-compose.yml',
    'docker-compose.single.yml',
    'docker-compose.quick.yml',
    'docker-compose.quick.single.yml',
    'docker-compose.quick.single.macvlan.yml',
    'Dockerfile',
    'Dockerfile.server',
    'Dockerfile.console',
    'VERSION',
]);

function isNonCriticalUpdateFailure(fileKey) {
    return NON_CRITICAL_UPDATE_FAILURES.has(fileKey);
}

function localPathFromFailureFile(fileKey) {
    if (!fileKey || typeof fileKey !== 'string') return '';
    return fileKey.startsWith('web-nodejs/') ? fileKey.slice('web-nodejs/'.length) : fileKey;
}

/** Repair step asked for a path Node never loads (routes.js, duplicated scripts/). */
function isPhantomRepairFailure(fileKey, rootDir) {
    const localPath = localPathFromFailureFile(fileKey);
    if (!localPath || !rootDir) return false;
    if (localPath === 'routes.js') {
        return fs.existsSync(path.join(rootDir, 'routes', 'index.js'));
    }
    if (/^scripts\/scripts\//.test(localPath)) return true;
    if (localPath.endsWith('.js')) {
        const indexPath = path.join(rootDir, `${localPath.slice(0, -3)}`, 'index.js');
        if (fs.existsSync(indexPath)) return true;
    }
    return false;
}

function isFailureNonCritical(entry, rootDir) {
    if (!entry) return false;
    if (entry.nonCritical) return true;
    if (isNonCriticalUpdateFailure(entry.file)) return true;
    if (entry.file === 'npm install' && entry.nodeModulesOk) return true;
    if (isPhantomRepairFailure(entry.file, rootDir)) return true;
    return false;
}

function splitUpdateFailures(failed, rootDir) {
    const critical = [];
    const nonCritical = [];
    for (const entry of failed || []) {
        if (isFailureNonCritical(entry, rootDir)) nonCritical.push(entry);
        else critical.push(entry);
    }
    return { critical, nonCritical };
}

function canScheduleConsoleRestart(result, dataDir) {
    if (!result?.needsConsoleRestart) {
        return { allowed: false };
    }
    const patch = result.servicePatch || {};
    if (patch.consolePermissionsOk !== false) {
        return { allowed: true };
    }
    try {
        fs.accessSync(dataDir, fs.constants.W_OK);
        return {
            allowed: true,
            note: 'Console data directory is writable — restart allowed despite permission-sync warning',
        };
    } catch (_) {
        return {
            allowed: false,
            blockedReason: patch.consoleUserError
                || `Console data directory is not writable: ${dataDir}`,
        };
    }
}

module.exports = {
    NON_CRITICAL_UPDATE_FAILURES,
    isNonCriticalUpdateFailure,
    isPhantomRepairFailure,
    isFailureNonCritical,
    splitUpdateFailures,
    canScheduleConsoleRestart,
    localPathFromFailureFile,
};
