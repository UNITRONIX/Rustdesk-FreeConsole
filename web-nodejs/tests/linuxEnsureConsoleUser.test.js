'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    buildUpdateSudoersContent,
    resolveSystemctlPath,
    getSharedGoDataDirPermissionSteps,
    listSharedGoDataFiles,
    applySharedGoFilePermissions,
    readEnvFileValue,
    isTruthyEnvValue,
    resolveLetsEncryptLiveDir,
    shouldRedeployLetsEncryptMaterial,
    safeCopyTlsFile,
    upsertEnvFileValue,
    repairInvalidServiceUserLine,
    serviceUserLineIsValid,
    SHARED_GO_DATA_DIR_MODE,
    SHARED_GO_SSL_DIR_MODE,
    SVC_USER,
} = require('../scripts/linux-ensure-console-user');
const { ensureBindCapabilityInServiceUnit } = require('../lib/privilegedPorts');

describe('linux-ensure-console-user helpers', () => {
    test('buildUpdateSudoersContent references resolved binary paths', () => {
        const content = buildUpdateSudoersContent();
        expect(content).toContain('# Managed by BetterDesk linux-ensure-console-user.js');
        expect(content).toContain(`${SVC_USER} ALL=(root) NOPASSWD: ${resolveSystemctlPath()}`);
        expect(content).toMatch(/NOPASSWD: \/usr\/bin\/journalctl|NOPASSWD: \/bin\/journalctl/);
        expect(content).toContain('linux-deploy-server-binary.js');
        expect(content).toContain('linux-write-systemd-unit.js');
        expect(content).toContain('linux-ensure-console-user.js');
    });

    test('resolveSystemctlPath returns an existing path when available', () => {
        const resolved = resolveSystemctlPath();
        expect(typeof resolved).toBe('string');
        expect(resolved.endsWith('systemctl')).toBe(true);
    });

    test('ensureBindCapabilityInServiceUnit inserts capability lines after User=', () => {
        const unit = [
            '[Service]',
            'User=betterdesk',
            'ExecStart=/usr/bin/node server.js',
        ].join('\n');
        const patched = ensureBindCapabilityInServiceUnit(unit);
        expect(patched.changed).toBe(true);
        expect(patched.content.indexOf('User=betterdesk')).toBeLessThan(
            patched.content.indexOf('AmbientCapabilities=CAP_NET_BIND_SERVICE')
        );
    });

    test('getSharedGoDataDirPermissionSteps uses setgid modes for Go data dir (#206)', () => {
        const rustdeskPath = '/opt/betterdesk';
        const steps = getSharedGoDataDirPermissionSteps(rustdeskPath, SVC_USER);
        expect(steps).toEqual(expect.arrayContaining([
            { bin: 'chown', args: [`root:${SVC_USER}`, rustdeskPath] },
            { bin: 'chmod', args: [SHARED_GO_DATA_DIR_MODE, rustdeskPath] },
            { bin: 'chown', args: [`root:${SVC_USER}`, path.join(rustdeskPath, 'ssl')] },
            { bin: 'chmod', args: [SHARED_GO_SSL_DIR_MODE, path.join(rustdeskPath, 'ssl')] },
        ]));
        expect(SHARED_GO_DATA_DIR_MODE).toBe('2775');
        expect(SHARED_GO_SSL_DIR_MODE).toBe('2750');
    });

    test('listSharedGoDataFiles includes sqlite db and wal/shm sidecars', () => {
        const base = '/opt/betterdesk';
        const files = listSharedGoDataFiles(base);
        expect(files).toContain(path.join(base, 'db_v2.sqlite3'));
        expect(files).toContain(path.join(base, 'db_v2.sqlite3-wal'));
        expect(files).toContain(path.join(base, 'db_v2.sqlite3-shm'));
        expect(files).toContain(path.join(base, '.api_key'));
    });

    test('applySharedGoFilePermissions sets group rw on db files', () => {
        const tmpDb = path.join(os.tmpdir(), `db_v2.sqlite3-test-${Date.now()}`);
        fs.writeFileSync(tmpDb, '');
        try {
            const calls = [];
            const runFn = (bin, args) => { calls.push([bin, ...args]); };
            applySharedGoFilePermissions(tmpDb, SVC_USER, runFn);
            expect(calls).toEqual([
                ['chown', `root:${SVC_USER}`, tmpDb],
                ['chmod', 'g+r', tmpDb],
                ['chmod', 'g+rw', tmpDb],
            ]);
        } finally {
            fs.unlinkSync(tmpDb);
        }
    });

    test('resolveLetsEncryptLiveDir prefers LE_CERT_LIVE_DIR then cert path (#219)', () => {
        expect(resolveLetsEncryptLiveDir({
            leCertLiveDir: '/etc/letsencrypt/live/desk.example.com',
            sslCertPath: '/opt/rustdesk/ssl/betterdesk.crt',
        })).toBe('/etc/letsencrypt/live/desk.example.com');

        expect(resolveLetsEncryptLiveDir({
            sslCertPath: '/etc/letsencrypt/live/desk.example.com/fullchain.pem',
        })).toBe('/etc/letsencrypt/live/desk.example.com');
    });

    test('resolveLetsEncryptLiveDir falls back to LE_CERT_DOMAIN (#219)', () => {
        const envPath = path.join(os.tmpdir(), `le-domain-env-${Date.now()}.env`);
        fs.writeFileSync(envPath, 'LE_CERT_DOMAIN=desk.example.com\n');
        try {
            expect(resolveLetsEncryptLiveDir({
                envPath,
                sslCertPath: '/opt/rustdesk/ssl/betterdesk.crt',
                leCertDomain: 'desk.example.com',
            })).toBe(path.join('/etc/letsencrypt/live', 'desk.example.com'));
        } finally {
            fs.unlinkSync(envPath);
        }
    });

    test('shouldRedeployLetsEncryptMaterial when LE paths or unreadable key (#219)', () => {
        expect(shouldRedeployLetsEncryptMaterial({
            httpsEnabled: 'false',
            sslKeyPath: '/etc/letsencrypt/live/x/privkey.pem',
        })).toBe(false);

        expect(shouldRedeployLetsEncryptMaterial({
            httpsEnabled: 'true',
            sslKeyPath: '/etc/letsencrypt/live/x/privkey.pem',
            sslCertPath: '/opt/rustdesk/ssl/betterdesk.crt',
            keyReadable: true,
        })).toBe(true);

        expect(shouldRedeployLetsEncryptMaterial({
            httpsEnabled: 'true',
            sslKeyPath: '/opt/rustdesk/ssl/betterdesk.key',
            sslCertPath: '/opt/rustdesk/ssl/betterdesk.crt',
            keyReadable: false,
        })).toBe(true);

        expect(shouldRedeployLetsEncryptMaterial({
            httpsEnabled: 'true',
            sslKeyPath: '/opt/rustdesk/ssl/betterdesk.key',
            sslCertPath: '/opt/rustdesk/ssl/betterdesk.crt',
            keyReadable: true,
        })).toBe(false);
    });

    test('readEnvFileValue and upsertEnvFileValue round-trip', () => {
        const envPath = path.join(os.tmpdir(), `betterdesk-env-${Date.now()}.env`);
        fs.writeFileSync(envPath, 'HTTPS_ENABLED=true\nPORT=5000\n');
        try {
            expect(readEnvFileValue('HTTPS_ENABLED', envPath)).toBe('true');
            expect(isTruthyEnvValue(readEnvFileValue('HTTPS_ENABLED', envPath))).toBe(true);
            upsertEnvFileValue('SSL_KEY_PATH', '/opt/rustdesk/ssl/betterdesk.key', envPath);
            expect(readEnvFileValue('SSL_KEY_PATH', envPath)).toBe('/opt/rustdesk/ssl/betterdesk.key');
            upsertEnvFileValue('PORT', '5001', envPath);
            expect(readEnvFileValue('PORT', envPath)).toBe('5001');
        } finally {
            fs.unlinkSync(envPath);
        }
    });

    test('safeCopyTlsFile removes same-file dest before cp (#219)', () => {
        const src = '/etc/letsencrypt/live/desk.example.com/fullchain.pem';
        const dest = '/opt/betterdesk/ssl/betterdesk.crt';
        const sameInode = '/same/inode/fullchain.pem';
        const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation((p) => {
            if (p === src || p === dest) return sameInode;
            return p;
        });
        const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === src || p === dest);

        const calls = [];
        safeCopyTlsFile(src, dest, (bin, args) => { calls.push([bin, ...args]); });

        expect(calls[0]).toEqual(['rm', '-f', dest]);
        expect(calls).toEqual(expect.arrayContaining([
            ['cp', '-L', src, expect.stringMatching(/\.tmp$/)],
            ['mv', '-f', expect.stringMatching(/\.tmp$/), dest],
        ]));

        realpathSpy.mockRestore();
        existsSpy.mockRestore();
    });

    test('safeCopyTlsFile uses temp file for normal copy (#219)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-tls-'));
        const src = path.join(tmpDir, 'privkey.pem');
        const dest = path.join(tmpDir, 'betterdesk.key');
        fs.writeFileSync(src, 'KEY');
        const calls = [];
        safeCopyTlsFile(src, dest, (bin, args) => { calls.push([bin, ...args]); });
        expect(calls[0][0]).toBe('cp');
        expect(calls[0][1]).toBe('-L');
        expect(calls[1][0]).toBe('mv');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('serviceUserLineIsValid accepts root or betterdesk only (#219)', () => {
        expect(serviceUserLineIsValid('[Service]\nUser=betterdesk\nExecStart=node server.js')).toBe(true);
        expect(serviceUserLineIsValid('[Service]\nUser=root\nExecStart=node server.js')).toBe(true);
        expect(serviceUserLineIsValid('[Service]\nUser=!\nUser=betterdesk\n')).toBe(false);
    });

    test('repairInvalidServiceUserLine fixes stdout-polluted User= (#219)', () => {
        const corrupted = [
            '[Service]',
            'User=! LE certificate symlinks detected but live dir not found',
            'betterdesk',
            'ExecStart=/usr/bin/node server.js',
        ].join('\n');
        const repaired = repairInvalidServiceUserLine(corrupted, SVC_USER);
        expect(repaired.changed).toBe(true);
        expect(repaired.content).toMatch(/^User=betterdesk$/m);
        expect(repaired.content.match(/^User=/gm)).toHaveLength(1);
        expect(serviceUserLineIsValid(repaired.content)).toBe(true);
    });
});
