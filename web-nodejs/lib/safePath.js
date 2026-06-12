'use strict';

const fs = require('fs');
const path = require('path');

/**
 * True when resolvedPath is rootDir or a descendant (no .. escape).
 */
function isPathInsideRoot(resolvedPath, rootDir) {
    const root = path.resolve(rootDir);
    const target = path.resolve(resolvedPath);
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a single path segment under rootDir (no slashes in childName).
 */
function resolveChildPath(rootDir, childName) {
    if (typeof childName !== 'string' || childName.length === 0) {
        throw new Error('Invalid path segment');
    }
    if (childName.includes('\0') || childName.includes('/') || childName.includes('\\')) {
        throw new Error('Invalid path segment');
    }
    if (childName === '.' || childName === '..') {
        throw new Error('Invalid path segment');
    }
    const root = path.resolve(rootDir);
    const target = path.resolve(root, childName);
    if (!isPathInsideRoot(target, root)) {
        throw new Error('Path outside allowed directory');
    }
    return target;
}

/**
 * Resolve userPath and ensure it stays within rootDir.
 */
function resolvePathWithinRoot(userPath, rootDir) {
    if (typeof userPath !== 'string' || userPath.length === 0) {
        throw new Error('Path is required');
    }
    if (userPath.includes('\0')) {
        throw new Error('Invalid path');
    }
    const root = path.resolve(rootDir);
    const abs = path.resolve(userPath);
    if (!isPathInsideRoot(abs, root)) {
        throw new Error('Path outside allowed directory');
    }
    if (fs.existsSync(abs)) {
        const real = fs.realpathSync.native(abs);
        if (!isPathInsideRoot(real, root)) {
            throw new Error('Path resolves outside allowed directory');
        }
        return real;
    }
    return abs;
}

/**
 * Resolve userPath within the first matching allowed root.
 */
function resolvePathWithinAnyRoot(userPath, roots) {
    if (typeof userPath !== 'string' || userPath.length === 0) {
        throw new Error('Path is required');
    }
    if (userPath.includes('\0')) {
        throw new Error('Invalid path');
    }
    const abs = path.resolve(userPath);
    const normalizedRoots = roots.map((r) => path.resolve(r));
    const matched = normalizedRoots.some((root) => isPathInsideRoot(abs, root));
    if (!matched) {
        throw new Error('Path outside allowed directory roots');
    }
    if (fs.existsSync(abs)) {
        const real = fs.realpathSync.native(abs);
        const realMatched = normalizedRoots.some((root) => isPathInsideRoot(real, root));
        if (!realMatched) {
            throw new Error('Path resolves outside allowed directory roots');
        }
        return real;
    }
    return abs;
}

/**
 * Language JSON file under langDir (BCP 47 code validated by caller).
 */
function resolveLangFilePath(langDir, code) {
    const root = path.resolve(langDir);
    return resolveChildPath(root, `${code}.json`);
}

function readLangFileText(langDir, code) {
    const filePath = resolveLangFilePath(langDir, code);
    return fs.readFileSync(filePath, 'utf8');
}

function langFileExists(langDir, code) {
    const filePath = resolveLangFilePath(langDir, code);
    return fs.existsSync(filePath);
}

/**
 * Resolve a relative path (may contain slashes) under rootDir.
 */
function resolvePathUnderRoot(rootDir, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new Error('Relative path is required');
    }
    if (relativePath.includes('\0')) {
        throw new Error('Invalid relative path');
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || normalized.startsWith('/')) {
        throw new Error('Invalid relative path');
    }
    const segments = normalized.split('/').filter((s) => s.length > 0);
    let current = path.resolve(rootDir);
    for (const segment of segments) {
        current = resolveChildPath(current, segment);
    }
    return current;
}

/**
 * Confined filesystem helpers — validation and I/O in one step so paths
 * never leave the allowed root between check and use.
 */
function existsConfinedChild(rootDir, childName) {
    const root = path.resolve(rootDir);
    const target = resolveChildPath(root, childName);
    return fs.existsSync(target);
}

function removeConfinedChild(rootDir, childName, options = { recursive: true, force: true }) {
    const root = path.resolve(rootDir);
    const target = resolveChildPath(root, childName);
    if (target === root) {
        throw new Error('Refusing to delete the root directory');
    }
    if (!fs.existsSync(target)) {
        throw new Error('Path not found');
    }
    fs.rmSync(target, options);
    return target;
}

function readTextConfinedWithinRoot(userPath, rootDir) {
    const abs = finalizedConfinedPathWithinRoot(userPath, rootDir);
    return fs.readFileSync(abs, 'utf8');
}

function existsConfinedWithinRoot(userPath, rootDir) {
    const abs = finalizedConfinedPathWithinRoot(userPath, rootDir);
    return fs.existsSync(abs);
}

/**
 * Resolve and finalize a confined path (realpath when present) before fs I/O.
 */
function finalizedConfinedPath(userPath, roots) {
    const abs = resolvePathWithinAnyRoot(userPath, roots);
    const resolvedRoots = roots.map((r) => path.resolve(r));
    if (fs.existsSync(abs)) {
        const real = fs.realpathSync.native(abs);
        if (!resolvedRoots.some((root) => isPathInsideRoot(real, root))) {
            throw new Error('Path resolves outside allowed directory roots');
        }
        return real;
    }
    return abs;
}

function finalizedConfinedPathWithinRoot(userPath, rootDir) {
    const abs = resolvePathWithinRoot(userPath, rootDir);
    const root = path.resolve(rootDir);
    if (fs.existsSync(abs)) {
        const real = fs.realpathSync.native(abs);
        if (!isPathInsideRoot(real, root)) {
            throw new Error('Path resolves outside allowed directory');
        }
        return real;
    }
    return abs;
}

function renameConfinedWithinRoots(oldPath, newPath, roots) {
    const a = finalizedConfinedPath(oldPath, roots);
    const b = finalizedConfinedPath(newPath, roots);
    fs.renameSync(a, b);
    return { from: a, to: b };
}

function unlinkConfinedWithinRoots(userPath, roots) {
    const abs = finalizedConfinedPath(userPath, roots);
    fs.unlinkSync(abs);
    return abs;
}

function mkdirConfinedWithinRoots(userPath, roots) {
    const abs = finalizedConfinedPath(userPath, roots);
    fs.mkdirSync(abs, { recursive: false });
    return abs;
}

function rmDirConfinedWithinRoots(userPath, roots) {
    const abs = finalizedConfinedPath(userPath, roots);
    fs.rmSync(abs, { recursive: true, force: false });
    return abs;
}

module.exports = {
    isPathInsideRoot,
    resolveChildPath,
    resolvePathWithinRoot,
    resolvePathWithinAnyRoot,
    resolveLangFilePath,
    resolvePathUnderRoot,
    readLangFileText,
    langFileExists,
    existsConfinedChild,
    removeConfinedChild,
    readTextConfinedWithinRoot,
    existsConfinedWithinRoot,
    renameConfinedWithinRoots,
    unlinkConfinedWithinRoots,
    mkdirConfinedWithinRoots,
    rmDirConfinedWithinRoots,
};
