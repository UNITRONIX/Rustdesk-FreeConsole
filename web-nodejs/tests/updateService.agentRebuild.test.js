'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const updateService = require('../services/updateService');

test('shouldQueueAgentRebuild triggers on support-agent source changes', () => {
    const data = {
        grouped: {
            supportAgent: [{ path: 'betterdesk-support-agent/urls.go' }],
        },
    };
    assert.equal(updateService.shouldQueueAgentRebuild(data), true);
});

test('shouldQueueAgentRebuild triggers on build worker-only commits', () => {
    const data = {
        grouped: {
            console: [{ path: 'web-nodejs/services/agentBuildWorker.js' }],
        },
    };
    assert.equal(updateService.shouldQueueAgentRebuild(data), true);
});

test('shouldQueueAgentRebuild ignores unrelated console changes', () => {
    const data = {
        grouped: {
            console: [{ path: 'web-nodejs/views/settings.ejs' }],
        },
    };
    assert.equal(updateService.shouldQueueAgentRebuild(data), false);
});
