'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVER_BINARY_NAME = 'betterdesk-server';
const ALLOWED_TARGET_DIRS = [
    '/opt/rustdesk',
    '/opt/betterdesk',
    '/usr/local/bin',
];

function resolveDeployScriptPath(consoleRoot) {
    return path.join(consoleRoot, 'scripts/linux-deploy-server-binary.js');
}

function resolveServerSourceRoot(consoleRoot, projectRoot) {
    const flat = path.join(consoleRoot, 'betterdesk-server');
    if (fs.existsSync(path.join(flat, 'go.mod'))) {
        return flat;
    }
    return path.join(projectRoot, 'betterdesk-server');
}

function normalizeDeployPath(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!path.isAbsolute(trimmed)) return null;
    return path.resolve(trimmed);
}

function resolveRealFile(filePath) {
    const normalized = normalizeDeployPath(filePath);
    if (!normalized || !fs.existsSync(normalized)) {
        throw new Error(`Source file not found: ${filePath}`);
    }
    const real = fs.realpathSync(normalized);
    if (!fs.statSync(real).isFile()) {
        throw new Error(`Source is not a regular file: ${filePath}`);
    }
    return real;
}

function buildAllowedDeployTargets(options = {}) {
    const targets = new Set();
    for (const dir of ALLOWED_TARGET_DIRS) {
        targets.add(path.join(dir, SERVER_BINARY_NAME));
    }

    const keysPath = options.keysPath || options.rustdeskDir;
    if (keysPath) {
        targets.add(path.join(path.resolve(keysPath), SERVER_BINARY_NAME));
    }

    const fromEnv = process.env.BETTERDESK_SERVER_BINARY;
    if (fromEnv) {
        const normalized = normalizeDeployPath(fromEnv);
        if (normalized) targets.add(normalized);
    }

    if (options.extraTarget) {
        const normalized = normalizeDeployPath(options.extraTarget);
        if (normalized) targets.add(normalized);
    }

    if (options.projectRoot) {
        targets.add(path.join(path.resolve(options.projectRoot), 'betterdesk-server', SERVER_BINARY_NAME));
    }

    if (options.consoleRoot) {
        targets.add(path.join(path.resolve(options.consoleRoot), 'betterdesk-server', SERVER_BINARY_NAME));
    }

    return targets;
}

function isPathInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateDeployRequest(sourcePath, targetPath, options = {}) {
    const consoleRoot = path.resolve(options.consoleRoot || path.join(__dirname, '..'));
    const projectRoot = path.resolve(options.projectRoot || path.join(consoleRoot, '..'));
    const serverSourceRoot = path.resolve(
        options.serverSourceRoot || resolveServerSourceRoot(consoleRoot, projectRoot)
    );

    const sourceReal = resolveRealFile(sourcePath);
    const serverRootReal = fs.realpathSync(serverSourceRoot);
    if (!isPathInside(serverRootReal, sourceReal)) {
        throw new Error(`Source must be under ${serverRootReal}`);
    }
    if (path.basename(sourceReal) !== SERVER_BINARY_NAME) {
        throw new Error(`Source must be named ${SERVER_BINARY_NAME}`);
    }

    const stat = fs.statSync(sourceReal);
    if (stat.size < 512 * 1024) {
        throw new Error('Source binary is unexpectedly small');
    }

    const targetNormalized = normalizeDeployPath(targetPath);
    if (!targetNormalized) {
        throw new Error('Target path must be absolute');
    }
    if (path.basename(targetNormalized) !== SERVER_BINARY_NAME) {
        throw new Error(`Target must be named ${SERVER_BINARY_NAME}`);
    }

    const allowedTargets = buildAllowedDeployTargets({
        keysPath: options.keysPath,
        rustdeskDir: options.rustdeskDir,
        extraTarget: options.extraTarget,
        projectRoot: options.projectRoot,
        consoleRoot: options.consoleRoot,
    });
    const targetReal = fs.existsSync(targetNormalized)
        ? fs.realpathSync(targetNormalized)
        : targetNormalized;

    let allowed = false;
    for (const candidate of allowedTargets) {
        const candidateReal = fs.existsSync(candidate)
            ? fs.realpathSync(candidate)
            : path.resolve(candidate);
        if (candidateReal === targetReal || candidateReal === targetNormalized) {
            allowed = true;
            break;
        }
    }
    if (!allowed) {
        throw new Error(`Target path is not allowed: ${targetNormalized}`);
    }

    return {
        sourceReal,
        targetPath: targetNormalized,
        serverSourceRoot: serverRootReal,
    };
}

/**
 * Atomic replace for a running Linux executable (rename over directory entry).
 * @returns {{ success: boolean, backupPath?: string|null, error?: string }}
 */
function deployServerBinaryAtomic(sourceReal, targetPath) {
    let backupPath = null;
    if (fs.existsSync(targetPath)) {
        backupPath = `${targetPath}.bak.${Date.now()}`;
        try {
            fs.copyFileSync(targetPath, backupPath);
        } catch (err) {
            return { success: false, error: `Backup failed: ${err.message}` };
        }
    }

    const stagingPath = `${targetPath}.new.${process.pid}.${Date.now()}`;
    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourceReal, stagingPath);
        try { fs.chmodSync(stagingPath, 0o755); } catch (_e) { /* ok */ }

        try {
            fs.renameSync(stagingPath, targetPath);
        } catch (renameErr) {
            try {
                fs.copyFileSync(stagingPath, targetPath);
                try { fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
                try { fs.chmodSync(targetPath, 0o755); } catch (_e) { /* ok */ }
            } catch (copyErr) {
                throw renameErr.code === 'ETXTBSY' ? renameErr : copyErr;
            }
        }
        return { success: true, backupPath };
    } catch (err) {
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
        if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
            try { fs.copyFileSync(backupPath, targetPath); } catch (_e) { /* critical */ }
        }
        return { success: false, error: `Deploy failed: ${err.message}` };
    }
}

function canWriteDirectory(dirPath) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK);
        return true;
    } catch (_e) {
        return false;
    }
}

function canUsePrivilegedDeploy(scriptPath) {
    if (process.platform !== 'linux' || !scriptPath || !fs.existsSync(scriptPath)) {
        return false;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        return true;
    }
    try {
        execSync(`sudo -n ${JSON.stringify(scriptPath)} --check`, {
            timeout: 5000,
            stdio: 'pipe',
        });
        return true;
    } catch (_e) {
        return false;
    }
}

/**
 * @returns {{ ready: boolean, method?: 'direct'|'privileged', scriptPath?: string, targetDir?: string }}
 */
function assessServerBinaryDeployCapability(targetPath, options = {}) {
    const normalized = normalizeDeployPath(targetPath);
    if (!normalized) {
        return { ready: false };
    }
    const targetDir = path.dirname(normalized);
    if (canWriteDirectory(targetDir)) {
        return { ready: true, method: 'direct', targetDir };
    }
    const consoleRoot = options.consoleRoot || path.join(__dirname, '..');
    const scriptPath = resolveDeployScriptPath(consoleRoot);
    if (canUsePrivilegedDeploy(scriptPath)) {
        return { ready: true, method: 'privileged', scriptPath, targetDir };
    }
    return { ready: false, scriptPath, targetDir };
}

module.exports = {
    SERVER_BINARY_NAME,
    ALLOWED_TARGET_DIRS,
    resolveDeployScriptPath,
    resolveServerSourceRoot,
    buildAllowedDeployTargets,
    validateDeployRequest,
    deployServerBinaryAtomic,
    assessServerBinaryDeployCapability,
    canUsePrivilegedDeploy,
};
