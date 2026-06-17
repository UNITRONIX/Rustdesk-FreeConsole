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
        const files = listSharedGoDataFiles('/opt/betterdesk');
        expect(files).toContain('/opt/betterdesk/db_v2.sqlite3');
        expect(files).toContain('/opt/betterdesk/db_v2.sqlite3-wal');
        expect(files).toContain('/opt/betterdesk/db_v2.sqlite3-shm');
        expect(files).toContain('/opt/betterdesk/.api_key');
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
});
