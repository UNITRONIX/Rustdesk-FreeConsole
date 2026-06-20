'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('agentClientBuildWorker module', () => {
    it('exports startWorker and enqueueBuildsForHash', () => {
        const worker = require('../services/agentClientBuildWorker');
        assert.equal(typeof worker.startWorker, 'function');
        assert.equal(typeof worker.enqueueBuildsForHash, 'function');
        assert.equal(typeof worker.rebuildBundleById, 'function');
    });
});
