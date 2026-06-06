'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('agentBuildWorker pending rebuild flag', () => {
    let dataDir;
    let origDataDir;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-rebuild-'));
        origDataDir = process.env.DATA_DIR;
        process.env.DATA_DIR = dataDir;
        delete require.cache[require.resolve('../config/config')];
        delete require.cache[require.resolve('../services/agentBuildWorker')];
    });

    afterEach(() => {
        process.env.DATA_DIR = origDataDir;
        delete require.cache[require.resolve('../config/config')];
        delete require.cache[require.resolve('../services/agentBuildWorker')];
        if (dataDir && fs.existsSync(dataDir)) {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('markRebuildPending + processPendingRebuildOnStartup clears flag', async () => {
        const worker = require('../services/agentBuildWorker');
        worker.markRebuildPending('test');
        const flagPath = path.join(dataDir, '.agent_rebuild_pending');
        expect(fs.existsSync(flagPath)).toBe(true);

        const db = require('../services/database');
        const origList = db.listAgentBundles;
        db.listAgentBundles = async () => [];

        try {
            const result = await worker.processPendingRebuildOnStartup();
            expect(result.bundles).toBe(0);
            expect(result.reason).toBe('test');
            expect(fs.existsSync(flagPath)).toBe(false);
        } finally {
            db.listAgentBundles = origList;
        }
    });
});
