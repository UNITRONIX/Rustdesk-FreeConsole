'use strict';

const fs = require('fs');
const path = require('path');

/**
 * True when `dirPath` is a filesystem / drive root (`/` or `C:\`).
 * Node's `fs.mkdirSync('C:\\', { recursive: true })` throws EPERM on Windows
 * even though the root already exists (issue #272).
 */
function isFilesystemRoot(dirPath) {
    const resolved = path.resolve(dirPath);
    return path.dirname(resolved) === resolved;
}

/**
 * Resolve the git / install project root used for Scripts & Docker updates.
 *
 * Layouts:
 * - Repo checkout: `…/BetterDesk/web-nodejs` → parent with `betterdesk-server/go.mod`
 * - Flat console: `…/BetterDeskConsole` with nested `betterdesk-server/go.mod` → console dir
 * - Split Windows install: `C:\BetterDeskConsole` (no nested server) → console dir,
 *   never `C:\` (drive root). Writing installer scripts to the drive root caused
 *   `EPERM: mkdir 'C:\'` and blocked SHA tracking (#272).
 *
 * @param {string} rootDir  Console root (`web-nodejs/` or flat install dir)
 * @param {{ existsSync?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
function resolveProjectRoot(rootDir, opts = {}) {
    const exists = opts.existsSync || fs.existsSync;
    const resolvedRoot = path.resolve(rootDir);

    const flatServerMod = path.join(resolvedRoot, 'betterdesk-server', 'go.mod');
    if (exists(flatServerMod)) {
        return resolvedRoot;
    }

    const parentAsRepo = path.resolve(resolvedRoot, '..');
    if (isFilesystemRoot(parentAsRepo)) {
        return resolvedRoot;
    }

    const parentMarkers = [
        path.join(parentAsRepo, 'betterdesk-server', 'go.mod'),
        path.join(parentAsRepo, 'web-nodejs', 'server.js'),
        path.join(parentAsRepo, 'betterdesk.sh'),
        path.join(parentAsRepo, 'betterdesk.ps1'),
    ];
    if (parentMarkers.some((p) => exists(p))) {
        return parentAsRepo;
    }

    // Split installs (console alone): keep scripts next to the writable console.
    return resolvedRoot;
}

/**
 * Create parent directories for a file path, skipping filesystem/drive roots
 * where mkdir would throw EPERM on Windows (#272).
 */
function ensureParentDirForFile(filePath, opts = {}) {
    const mkdirSync = opts.mkdirSync || ((p, o) => fs.mkdirSync(p, o));
    const dir = path.dirname(path.resolve(filePath));
    if (isFilesystemRoot(dir)) return;
    mkdirSync(dir, { recursive: true });
}

/** Permission / ACL errors that should not block SHA save for optional files. */
function isUpdatePermissionError(err) {
    if (!err) return false;
    if (err.code === 'EACCES' || err.code === 'EPERM') return true;
    return /permission denied|operation not permitted|access is denied/i.test(String(err.message || ''));
}

module.exports = {
    isFilesystemRoot,
    resolveProjectRoot,
    ensureParentDirForFile,
    isUpdatePermissionError,
};
