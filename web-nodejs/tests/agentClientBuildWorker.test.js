'use strict';

jest.mock('../services/database', () => ({}));
jest.mock('../services/agentBundleService', () => ({}));
jest.mock('../config/config', () => ({ dataDir: '/tmp/betterdesk-test' }));

describe('agentClientBuildWorker module', () => {
    it('exports startWorker and enqueueBuildsForHash', () => {
        const worker = require('../services/agentClientBuildWorker');
        expect(typeof worker.startWorker).toBe('function');
        expect(typeof worker.enqueueBuildsForHash).toBe('function');
        expect(typeof worker.rebuildBundleById).toBe('function');
    });
});
