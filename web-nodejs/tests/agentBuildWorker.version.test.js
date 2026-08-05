'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('agentBuildWorker product version injection', () => {
    let rootDir;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-version-'));
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    test('reads root VERSION and injects it into the copied Support Agent source', async () => {
        const workspace = path.join(rootDir, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(rootDir, 'VERSION'), '7.6.5\n');
        fs.writeFileSync(
            path.join(workspace, 'main.go'),
            'package main\n\nvar version = "0.1.0"\n'
        );

        const worker = require('../services/agentBuildWorker');
        const version = await worker._internals.injectSupportAgentVersion(workspace, { rootDir });

        expect(version).toBe('7.6.5');
        expect(worker._internals.getSupportAgentBuildVersion({ rootDir })).toBe('7.6.5');
        expect(fs.readFileSync(path.join(workspace, 'main.go'), 'utf8'))
            .toContain('var version = "7.6.5"');
    });
});
