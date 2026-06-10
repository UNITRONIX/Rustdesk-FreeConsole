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

module.exports = {
    isPathInsideRoot,
    resolveChildPath,
    resolvePathWithinRoot,
    resolvePathWithinAnyRoot,
    resolveLangFilePath,
    resolvePathUnderRoot,
};
