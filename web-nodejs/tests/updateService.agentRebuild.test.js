'use strict';

const updateService = require('../services/updateService');

describe('updateService shouldQueueAgentRebuild', () => {
    it('triggers on support-agent source changes', () => {
        const data = {
            grouped: {
                supportAgent: [{ path: 'betterdesk-support-agent/urls.go' }],
            },
        };
        expect(updateService.shouldQueueAgentRebuild(data)).toBe(true);
    });

    it('triggers on build worker-only commits', () => {
        const data = {
            grouped: {
                console: [{ path: 'web-nodejs/services/agentBuildWorker.js' }],
            },
        };
        expect(updateService.shouldQueueAgentRebuild(data)).toBe(true);
    });

    it('ignores unrelated console changes', () => {
        const data = {
            grouped: {
                console: [{ path: 'web-nodejs/views/settings.ejs' }],
            },
        };
        expect(updateService.shouldQueueAgentRebuild(data)).toBe(false);
    });
});
