'use strict';

const fs = require('fs');
const path = require('path');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function getProjectRoot() {
    return path.join(__dirname, '..', '..');
}

function readPackageJsonVersion(consoleDir) {
    try {
        const pkgPath = path.join(consoleDir || path.join(__dirname, '..'), 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const v = (pkg.version || '').trim();
        return SEMVER_RE.test(v) ? v : null;
    } catch (_e) {
        return null;
    }
}

/**
 * Read canonical BetterDesk product version.
 * Prefers repo-root VERSION, then web-nodejs/package.json, then fallback.
 */
function readProductVersion({ rootDir, consoleDir, fallback = '0.0.0' } = {}) {
    const projectRoot = rootDir || getProjectRoot();
    const versionFile = path.join(projectRoot, 'VERSION');

    try {
        if (fs.existsSync(versionFile)) {
            const v = fs.readFileSync(versionFile, 'utf8').trim();
            if (SEMVER_RE.test(v)) return v;
        }
    } catch (_e) { /* fall through */ }

    const resolvedConsoleDir = consoleDir || path.join(projectRoot, 'web-nodejs');
    const consoleVersionFile = path.join(resolvedConsoleDir, 'VERSION');
    try {
        if (fs.existsSync(consoleVersionFile)) {
            const v = fs.readFileSync(consoleVersionFile, 'utf8').trim();
            if (SEMVER_RE.test(v)) return v;
        }
    } catch (_e) { /* fall through */ }

    const fromPkg = readPackageJsonVersion(resolvedConsoleDir);
    if (fromPkg) return fromPkg;

    return fallback;
}

module.exports = {
    SEMVER_RE,
    getProjectRoot,
    readProductVersion,
    readPackageJsonVersion,
};
