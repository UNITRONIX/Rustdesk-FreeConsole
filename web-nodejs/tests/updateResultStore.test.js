'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    persistUpdateResult,
    readLastUpdateResult,
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
});
