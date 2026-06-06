'use strict';

const { isNonCriticalUpdateFailure, NON_CRITICAL_UPDATE_FAILURES } = require('../services/updateService');

describe('updateService non-critical failures', () => {
    test('treats root-owned installer scripts as non-critical', () => {
        expect(isNonCriticalUpdateFailure('betterdesk.sh')).toBe(true);
        expect(isNonCriticalUpdateFailure('Dockerfile.server')).toBe(true);
    });

    test('treats console file failures as critical', () => {
        expect(isNonCriticalUpdateFailure('web-nodejs/services/dbAdapter.js')).toBe(false);
        expect(isNonCriticalUpdateFailure('npm install')).toBe(false);
    });

    test('keeps server binary failures non-critical', () => {
        expect(NON_CRITICAL_UPDATE_FAILURES.has('betterdesk-server')).toBe(true);
        expect(NON_CRITICAL_UPDATE_FAILURES.has('server-source')).toBe(true);
    });
});
