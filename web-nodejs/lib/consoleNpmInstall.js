'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_REQUIRED_PACKAGES = [
    'express',
    'ejs',
    'better-sqlite3',
    'axios',
];

/** Native addons that must actually load after package.json bumps (e.g. better-sqlite3 11→13). */
const DEFAULT_NATIVE_PACKAGES = [
    'better-sqlite3',
    'bcrypt',
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

/**
 * Resolve + load native Node addons from rootDir.
 * require.resolve alone is not enough: a failed rebuild leaves the package
 * folder in place but aborts server.js on `new Database()` / bcrypt.hashSync.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function verifyConsoleNativeBindings(rootDir, nativePackages = DEFAULT_NATIVE_PACKAGES) {
    for (const pkg of nativePackages) {
        let resolved;
        try {
            resolved = require.resolve(pkg, { paths: [rootDir] });
        } catch (err) {
            return { ok: false, error: `${pkg}: ${err.message}` };
        }
        try {
            // Drop cached binding so a just-rebuilt addon is reloaded.
            try { delete require.cache[resolved]; } catch (_e) { /* ok */ }
            const mod = require(resolved);
            if (pkg === 'better-sqlite3') {
                const db = new mod(':memory:');
                try {
                    db.prepare('SELECT 1 AS x').get();
                } finally {
                    db.close();
                }
            } else if (pkg === 'bcrypt') {
                mod.hashSync('betterdesk-native-check', 4);
            }
        } catch (err) {
            return { ok: false, error: `${pkg}: ${err.message}` };
        }
    }
    return { ok: true };
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
            let native = verifyConsoleNativeBindings(rootDir);
            if (!native.ok) {
                try {
                    execSync('npm rebuild better-sqlite3 bcrypt --no-audit --no-fund', {
                        cwd: rootDir,
                        timeout,
                        stdio: 'pipe',
                        env,
                    });
                    native = verifyConsoleNativeBindings(rootDir);
                } catch (rebuildErr) {
                    const rebuildDetail = (rebuildErr?.stderr && rebuildErr.stderr.toString())
                        || rebuildErr?.message
                        || native.error
                        || 'npm rebuild failed';
                    lastError = new Error(
                        `native bindings after install: ${native.error || 'failed'}; rebuild: ${String(rebuildDetail).trim().slice(0, 300)}`
                    );
                    ensureConsoleNpmDirs(dataDir);
                    continue;
                }
            }
            if (!native.ok) {
                lastError = new Error(`native bindings unusable: ${native.error}`);
                ensureConsoleNpmDirs(dataDir);
                continue;
            }
            return { success: true, attempts: attempt };
        } catch (err) {
            lastError = err;
            ensureConsoleNpmDirs(dataDir);
        }
    }

    const detail = (lastError?.stderr && lastError.stderr.toString())
        || lastError?.message
        || 'npm install failed';
    const resolvedOk = verifyConsoleNodeModules(rootDir);
    const native = verifyConsoleNativeBindings(rootDir);
    return {
        success: false,
        attempts: 2,
        error: String(detail).trim().slice(0, 500),
        nodeModulesOk: resolvedOk && native.ok,
        nativeError: native.ok ? undefined : native.error,
    };
}

module.exports = {
    DEFAULT_REQUIRED_PACKAGES,
    DEFAULT_NATIVE_PACKAGES,
    ensureConsoleNpmDirs,
    buildNpmInstallEnv,
    verifyConsoleNodeModules,
    verifyConsoleNativeBindings,
    runConsoleNpmInstall,
};
