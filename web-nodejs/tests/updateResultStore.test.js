'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    persistUpdateResult,
    readLastUpdateResult,
    clearLastUpdateResult,
    resolveLastUpdateResultForDisplay,
    shaMatches,
} = require('../lib/updateResultStore');

describe('updateResultStore', () => {
    let dataDir;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-update-result-'));
    });

    afterEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('persists and reads last update result', () => {
        persistUpdateResult(dataDir, {
            sha: 'abc1234567890',
            applied: 3,
            failed: [{ file: 'npm install', error: 'EACCES' }],
            servicesFailed: [{ service: 'server', error: 'sudo denied' }],
        });
        const record = readLastUpdateResult(dataDir);
        expect(record.sha).toBe('abc1234567890');
        expect(record.applied).toBe(3);
        expect(record.failed).toHaveLength(1);
        expect(record.servicesFailed).toHaveLength(1);
        expect(record.savedAt).toBeTruthy();
    });

    test('shaMatches accepts short and full SHAs', () => {
        const full = '6d4d42b1234567890abcdef1234567890abcdef12';
        expect(shaMatches('6d4d42b', full)).toBe(true);
        expect(shaMatches(full, '6d4d42b')).toBe(true);
        expect(shaMatches('deadbeef', full)).toBe(false);
    });

    test('resolveLastUpdateResultForDisplay clears stale record when local SHA reached target', () => {
        persistUpdateResult(dataDir, {
            sha: '6d4d42b1234567890abcdef1234567890abcdef12',
            failed: [
                { file: 'betterdesk.sh', error: 'EACCES', nonCritical: true },
                { file: 'betterdesk-server/api/auth_handlers.go', error: 'EACCES', nonCritical: true },
            ],
        });

        const resolved = resolveLastUpdateResultForDisplay(dataDir, {
            localSHA: '6d4d42b',
        });

        expect(resolved).toBeNull();
        expect(readLastUpdateResult(dataDir)).toBeNull();
    });

    test('resolveLastUpdateResultForDisplay clears non-critical-only failures', () => {
        persistUpdateResult(dataDir, {
            sha: 'abc1234567890',
            failed: [
                { file: 'betterdesk.sh', error: 'EACCES', nonCritical: true },
                { file: 'Dockerfile', error: 'EACCES' },
            ],
        });

        const resolved = resolveLastUpdateResultForDisplay(dataDir, {
            localSHA: '0000000',
        });

        expect(resolved).toBeNull();
        expect(readLastUpdateResult(dataDir)).toBeNull();
    });

    test('resolveLastUpdateResultForDisplay keeps critical console failures', () => {
        persistUpdateResult(dataDir, {
            sha: 'abc1234567890',
            failed: [
                { file: 'web-nodejs/services/dbAdapter.js', error: 'disk full' },
                { file: 'betterdesk.sh', error: 'EACCES', nonCritical: true },
            ],
        });

        const resolved = resolveLastUpdateResultForDisplay(dataDir, {
            localSHA: '0000000',
        });

        expect(resolved).not.toBeNull();
        expect(resolved.failed).toHaveLength(1);
        expect(resolved.failed[0].file).toBe('web-nodejs/services/dbAdapter.js');
        expect(resolved.nonCriticalFailures).toHaveLength(1);
    });

    test('clearLastUpdateResult removes persisted file', () => {
        persistUpdateResult(dataDir, { sha: 'abc1234567890', failed: [] });
        expect(clearLastUpdateResult(dataDir)).toBe(true);
        expect(readLastUpdateResult(dataDir)).toBeNull();
    });
});
