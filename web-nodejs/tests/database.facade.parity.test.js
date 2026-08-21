/**
 * Ensure critical adapter methods stay re-exported on the database.js facade.
 * Missing exports caused silent peerIds no-ops (#380).
 */

'use strict';

const REQUIRED_FACADE_METHODS = [
    'getUserPeerGrants',
    'setUserPeerGrants',
    'getUserStrategyGuid',
    'setUserStrategyAssignment',
    'resolveUserAssignmentKey',
];

describe('database.js facade parity (Issue #380)', () => {
    let facade;

    beforeAll(() => {
        jest.resetModules();
        const mockAdapter = {};
        for (const name of REQUIRED_FACADE_METHODS) {
            mockAdapter[name] = jest.fn().mockResolvedValue(name === 'getUserPeerGrants' ? [] : undefined);
        }
        jest.doMock('../services/dbAdapter', () => ({
            getAdapter: () => mockAdapter,
            DB_TYPE: 'sqlite',
        }));
        jest.doMock('../config/config', () => ({
            dataDir: '/tmp',
            dbPath: '/tmp/test.db',
            dbType: 'sqlite',
        }));
        facade = require('../services/database');
    });

    afterAll(() => {
        jest.resetModules();
        jest.dontMock('../services/dbAdapter');
        jest.dontMock('../config/config');
    });

    it.each(REQUIRED_FACADE_METHODS)('exports %s as a function', (methodName) => {
        expect(typeof facade[methodName]).toBe('function');
    });
});
