'use strict';

const fs = require('fs');
const path = require('path');

const CONSOLE_SKIP_PATH_PREFIXES = ['node_modules/', 'test/', 'tests/'];
const CONSOLE_SKIP_FILES = new Set(['package-lock.json']);
const CONSOLE_INTEGRITY_SEEDS = [
    'server.js',
    'routes/index.js',
    'routes/auth.routes.js',
    'routes/server-attestation.routes.js',
];

function stripJsCommentsForRequireScan(content) {
    return String(content || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n\r]*/g, '');
}

function createConsoleDeployGraph(rootDir) {
    function isConsoleDeployLocalPath(localPath) {
        if (!localPath || typeof localPath !== 'string') return false;
        if (CONSOLE_SKIP_FILES.has(localPath)) return false;
        return !CONSOLE_SKIP_PATH_PREFIXES.some(prefix => localPath.startsWith(prefix));
    }

    function resolveConsoleRequire(fromLocalPath, requirePath) {
        if (!requirePath || !requirePath.startsWith('.')) return null;
        const dir = path.posix.dirname(String(fromLocalPath || '').replace(/\\/g, '/'));
        let resolved = path.posix.normalize(path.posix.join(dir, requirePath));
        if (resolved.startsWith('../') || resolved.startsWith('/')) return null;

        const absNoExt = path.join(rootDir, resolved);
        if (fs.existsSync(absNoExt) && fs.statSync(absNoExt).isDirectory()) {
            return path.posix.join(resolved, 'index.js');
        }

        if (!resolved.endsWith('.js')) resolved += '.js';
        const absJs = path.join(rootDir, resolved);
        if (!fs.existsSync(absJs)) {
            const indexPath = path.posix.join(resolved.replace(/\.js$/, ''), 'index.js');
            if (fs.existsSync(path.join(rootDir, indexPath))) return indexPath;
        }
        return resolved;
    }

    function isResolvedByIndexModule(localPath) {
        if (!localPath.endsWith('.js')) return false;
        const indexPath = `${localPath.slice(0, -3)}/index.js`;
        return fs.existsSync(path.join(rootDir, indexPath));
    }

    function collectConsoleRequiredFiles(changedConsoleFiles = []) {
        const seeds = new Set(CONSOLE_INTEGRITY_SEEDS);
        for (const file of changedConsoleFiles || []) {
            if (file?.localPath) seeds.add(file.localPath);
        }

        const required = new Set();
        const queue = [...seeds];
        const visited = new Set();

        while (queue.length) {
            const localPath = queue.shift();
            if (!localPath || visited.has(localPath)) continue;
            visited.add(localPath);
            required.add(localPath);

            const abs = path.join(rootDir, localPath);
            if (!fs.existsSync(abs) || !/\.(js|mjs|cjs)$/.test(localPath)) continue;

            let content;
            try {
                content = fs.readFileSync(abs, 'utf8');
            } catch (_) {
                continue;
            }

            const scanContent = stripJsCommentsForRequireScan(content);
            for (const match of scanContent.matchAll(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
                const resolved = resolveConsoleRequire(localPath, match[1]);
                if (resolved && !visited.has(resolved)) queue.push(resolved);
            }
        }

        return required;
    }

    return {
        isConsoleDeployLocalPath,
        resolveConsoleRequire,
        isResolvedByIndexModule,
        collectConsoleRequiredFiles,
        CONSOLE_INTEGRITY_SEEDS,
    };
}

module.exports = {
    createConsoleDeployGraph,
    stripJsCommentsForRequireScan,
    CONSOLE_INTEGRITY_SEEDS,
};
