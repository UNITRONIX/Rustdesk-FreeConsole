'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('markRebuildPending + processPendingRebuildOnStartup clears flag', async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-rebuild-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    process.env.DATA_DIR = dataDir;
    delete require.cache[require.resolve('../config/config')];
    delete require.cache[require.resolve('../services/agentBuildWorker')];

    const worker = require('../services/agentBuildWorker');
    worker.markRebuildPending('test');
    const flagPath = path.join(dataDir, '.agent_rebuild_pending');
    assert.ok(fs.existsSync(flagPath));

    const db = require('../services/database');
    const origList = db.listAgentBundles;
    db.listAgentBundles = async () => [];
    t.after(() => { db.listAgentBundles = origList; });

    const result = await worker.processPendingRebuildOnStartup();
    assert.equal(result.bundles, 0);
    assert.equal(result.reason, 'test');
    assert.ok(!fs.existsSync(flagPath));
});
