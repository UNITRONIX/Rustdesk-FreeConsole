'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_REQUIRED_PACKAGES = [
    'express',
    'ejs',
    'better-sqlite3',
    'axios',
];

function ensureConsoleNpmDirs(dataDir) {
    const npmCache = path.join(dataDir, 'npm-cache');
    const serviceHome = path.join(dataDir, 'service-home');
    fs.mkdirSync(npmCache, { recursive: true });
    fs.mkdirSync(path.join(serviceHome, '.npm'), { recursive: true });
    return { npmCache, serviceHome };
}

function buildNpmInstallEnv(dataDir, baseEnv = process.env) {
    const { npmCache, serviceHome } = ensureConsoleNpmDirs(dataDir);
    return {
        ...baseEnv,
        HOME: serviceHome,
        npm_config_cache: npmCache,
        NPM_CONFIG_CACHE: npmCache,
        npm_config_update_notifier: 'false',
    };
}

function verifyConsoleNodeModules(rootDir, requiredPackages = DEFAULT_REQUIRED_PACKAGES) {
    for (const pkg of requiredPackages) {
        try {
            require.resolve(pkg, { paths: [rootDir] });
        } catch (_) {
            return false;
        }
    }
    return true;
}

function runConsoleNpmInstall(opts = {}) {
    const {
        rootDir,
        dataDir,
        execSync = require('child_process').execSync,
        timeout = 120000,
    } = opts;
    if (!rootDir || !dataDir) {
        throw new Error('rootDir and dataDir are required for npm install');
    }

    ensureConsoleNpmDirs(dataDir);
    const env = buildNpmInstallEnv(dataDir);
    const command = 'npm install --omit=dev --no-audit --no-fund';
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            execSync(command, { cwd: rootDir, timeout, stdio: 'pipe', env });
            return { success: true, attempts: attempt };
        } catch (err) {
            lastError = err;
            ensureConsoleNpmDirs(dataDir);
        }
    }

    const detail = (lastError?.stderr && lastError.stderr.toString())
        || lastError?.message
        || 'npm install failed';
    const nodeModulesOk = verifyConsoleNodeModules(rootDir);
    return {
        success: false,
        attempts: 2,
        error: String(detail).trim().slice(0, 500),
        nodeModulesOk,
    };
}

module.exports = {
    DEFAULT_REQUIRED_PACKAGES,
    ensureConsoleNpmDirs,
    buildNpmInstallEnv,
    verifyConsoleNodeModules,
    runConsoleNpmInstall,
};
