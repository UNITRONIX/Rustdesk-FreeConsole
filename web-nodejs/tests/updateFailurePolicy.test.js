'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    isNonCriticalUpdateFailure,
    isPhantomRepairFailure,
    splitUpdateFailures,
    canScheduleConsoleRestart,
} = require('../lib/updateFailurePolicy');

describe('updateFailurePolicy', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-policy-'));
        fs.mkdirSync(path.join(tmpRoot, 'routes'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'routes', 'index.js'), 'module.exports = {};\n');
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('treats npm install and service config as non-critical', () => {
        expect(isNonCriticalUpdateFailure('npm install')).toBe(true);
        expect(isNonCriticalUpdateFailure('betterdesk-server.service')).toBe(true);
        expect(isNonCriticalUpdateFailure('support-agent-source-sync')).toBe(true);
        expect(isNonCriticalUpdateFailure('support-agent-rebuild-defer')).toBe(true);
    });

    test('detects phantom repair paths', () => {
        expect(isPhantomRepairFailure('web-nodejs/routes.js', tmpRoot)).toBe(true);
        expect(isPhantomRepairFailure('web-nodejs/scripts/scripts/foo.js', tmpRoot)).toBe(true);
    });

    test('splitUpdateFailures separates critical console file errors', () => {
        const { critical, nonCritical } = splitUpdateFailures([
            { file: 'web-nodejs/routes.js', error: '404' },
            { file: 'npm install', error: 'failed', nodeModulesOk: true },
            { file: 'web-nodejs/services/dbAdapter.js', error: 'disk full' },
        ], tmpRoot);
        expect(critical.map(f => f.file)).toEqual(['web-nodejs/services/dbAdapter.js']);
        expect(nonCritical.length).toBe(2);
    });

    test('canScheduleConsoleRestart allows writable data dir despite patch warning', () => {
        const dataDir = path.join(tmpRoot, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const gate = canScheduleConsoleRestart({
            needsConsoleRestart: true,
            servicePatch: { consolePermissionsOk: false, consoleUserError: 'stale check' },
        }, dataDir);
        expect(gate.allowed).toBe(true);
    });
});
