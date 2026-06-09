'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConsoleDeployGraph } = require('../lib/consoleDeployGraph');

describe('consoleDeployGraph', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-graph-'));
        fs.mkdirSync(path.join(tmpRoot, 'routes'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'server.js'), "const routes = require('./routes');\n");
        fs.writeFileSync(path.join(tmpRoot, 'routes', 'index.js'), "module.exports = require('express').Router();\n");
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('resolves directory imports to index.js', () => {
        const graph = createConsoleDeployGraph(tmpRoot);
        expect(graph.resolveConsoleRequire('server.js', './routes')).toBe('routes/index.js');
    });

    test('skips phantom routes.js repair target', () => {
        const graph = createConsoleDeployGraph(tmpRoot);
        expect(graph.isResolvedByIndexModule('routes.js')).toBe(true);
    });

    test('does not treat removed changed files as repair seeds', () => {
        const graph = createConsoleDeployGraph(tmpRoot);
        const required = graph.collectConsoleRequiredFiles([
            { localPath: 'scripts/patch-update-channel-i18n.js', status: 'removed' },
        ]);
        expect(required.has('scripts/patch-update-channel-i18n.js')).toBe(false);
    });

    test('ignores require() examples inside block comments', () => {
        fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpRoot, 'scripts', 'linux-ensure-console-user.js'),
            '/* require(\'./scripts/linux-ensure-console-user\') */\nmodule.exports = {};\n'
        );
        const graph = createConsoleDeployGraph(tmpRoot);
        const required = graph.collectConsoleRequiredFiles([
            { localPath: 'scripts/linux-ensure-console-user.js' },
        ]);
        expect(required.has('scripts/scripts/linux-ensure-console-user.js')).toBe(false);
    });
});
