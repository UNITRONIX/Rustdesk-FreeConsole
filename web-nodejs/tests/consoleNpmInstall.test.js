'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildNpmInstallEnv,
    ensureConsoleNpmDirs,
    runConsoleNpmInstall,
    verifyConsoleNodeModules,
} = require('../lib/consoleNpmInstall');

describe('consoleNpmInstall', () => {
    let tmpRoot;
    let dataDir;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-npm-'));
        dataDir = path.join(tmpRoot, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({
            name: 'test-console',
            dependencies: { express: '^4.18.0' },
        }));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('buildNpmInstallEnv uses writable cache and HOME under dataDir', () => {
        const env = buildNpmInstallEnv(dataDir, {});
        expect(env.HOME).toBe(path.join(dataDir, 'service-home'));
        expect(env.npm_config_cache).toBe(path.join(dataDir, 'npm-cache'));
        expect(fs.existsSync(env.HOME)).toBe(true);
        expect(fs.existsSync(env.npm_config_cache)).toBe(true);
    });

    test('runConsoleNpmInstall retries and reports nodeModulesOk on failure', () => {
        let calls = 0;
        const execSync = () => {
            calls += 1;
            const err = new Error('EACCES cache');
            err.stderr = Buffer.from('npm ERR! EACCES');
            throw err;
        };
        fs.mkdirSync(path.join(tmpRoot, 'node_modules', 'express'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'express', 'package.json'), '{}');
        const result = runConsoleNpmInstall({
            rootDir: tmpRoot,
            dataDir,
            execSync,
        });
        expect(calls).toBe(2);
        expect(result.success).toBe(false);
        expect(result.nodeModulesOk).toBe(false);
    });

    test('verifyConsoleNodeModules checks required packages', () => {
        fs.mkdirSync(path.join(tmpRoot, 'node_modules', 'express'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'express', 'index.js'), 'module.exports = {};\n');
        fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'express', 'package.json'), '{"name":"express"}');
        expect(verifyConsoleNodeModules(tmpRoot, ['express'])).toBe(true);
        expect(verifyConsoleNodeModules(tmpRoot, ['missing-package-xyz'])).toBe(false);
    });

    test('ensureConsoleNpmDirs is idempotent', () => {
        ensureConsoleNpmDirs(dataDir);
        ensureConsoleNpmDirs(dataDir);
        expect(fs.existsSync(path.join(dataDir, 'npm-cache'))).toBe(true);
        expect(fs.existsSync(path.join(dataDir, 'service-home', '.npm'))).toBe(true);
    });
});
