'use strict';

const path = require('path');
const {
    isNonCriticalUpdateFailure,
    NON_CRITICAL_UPDATE_FAILURES,
    splitUpdateFailures,
} = require('../lib/updateFailurePolicy');
const { resolveServerSourceRootForUpdate } = require('../services/updateService');

describe('updateService non-critical failures', () => {
    test('treats root-owned installer scripts as non-critical', () => {
        expect(isNonCriticalUpdateFailure('betterdesk.sh')).toBe(true);
        expect(isNonCriticalUpdateFailure('Dockerfile.server')).toBe(true);
        expect(isNonCriticalUpdateFailure('docker-compose.quick.single.yml')).toBe(true);
        expect(isNonCriticalUpdateFailure('docker-compose.quick.single.macvlan.yml')).toBe(true);
    });

    test('treats npm install and service unit cleanup as non-critical', () => {
        expect(isNonCriticalUpdateFailure('npm install')).toBe(true);
        expect(isNonCriticalUpdateFailure('betterdesk-server.service')).toBe(true);
    });

    test('treats console file failures as critical', () => {
        expect(isNonCriticalUpdateFailure('web-nodejs/services/dbAdapter.js')).toBe(false);
    });

    test('keeps server binary failures non-critical', () => {
        expect(NON_CRITICAL_UPDATE_FAILURES.has('betterdesk-server')).toBe(true);
        expect(NON_CRITICAL_UPDATE_FAILURES.has('server-source')).toBe(true);
    });

    test('falls back to console-local server source when legacy root-owned source is not writable', () => {
        if (process.platform === 'win32') {
            // On Windows the updater always prefers the configured server root
            // (no root-owned /opt layout). Skip the Linux-only fallback path.
            return;
        }
        const legacyRoot = '/opt/betterdesk-server';
        const consoleRoot = path.join('/opt', 'BetterDeskConsole', 'betterdesk-server');

        const selected = resolveServerSourceRootForUpdate(legacyRoot, {
            fallbackRoot: consoleRoot,
            canWriteDir: (candidate) => candidate === consoleRoot,
        });

        expect(selected).toBe(consoleRoot);
    });

    test('keeps legacy server-source failures non-critical while console file failures stay critical', () => {
        const { critical, nonCritical } = splitUpdateFailures([
            { file: 'server-source', error: 'Source download failed: EACCES' },
            { file: 'betterdesk-server/api/auth_handlers.go', error: 'EACCES', nonCritical: true },
            { file: 'web-nodejs/services/dbAdapter.js', error: 'disk full' },
        ]);

        expect(nonCritical.map(f => f.file)).toEqual([
            'server-source',
            'betterdesk-server/api/auth_handlers.go',
        ]);
        expect(critical.map(f => f.file)).toEqual(['web-nodejs/services/dbAdapter.js']);
    });
});
