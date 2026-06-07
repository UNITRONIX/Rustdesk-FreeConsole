'use strict';

const { createConsoleDeployGraph } = require('../lib/consoleDeployGraph');
const {
    GITHUB_COMPARE_FILE_LIMIT,
    isCompareLikelyTruncated,
} = require('../services/updateService');

describe('updateService console sync helpers', () => {
    test('detects truncated GitHub compare responses', () => {
        expect(GITHUB_COMPARE_FILE_LIMIT).toBe(300);
        expect(isCompareLikelyTruncated(299)).toBe(false);
        expect(isCompareLikelyTruncated(300)).toBe(true);
        expect(isCompareLikelyTruncated(450)).toBe(true);
    });

    test('resolves relative console require paths', () => {
        const graph = createConsoleDeployGraph(require('path').join(__dirname, '..'));
        expect(graph.resolveConsoleRequire('routes/auth.routes.js', '../services/serverAttestation'))
            .toBe('services/serverAttestation.js');
        expect(graph.resolveConsoleRequire('routes/index.js', './devices.routes'))
            .toBe('routes/devices.routes.js');
        expect(graph.resolveConsoleRequire('server.js', './routes'))
            .toBe('routes/index.js');
        expect(graph.resolveConsoleRequire('server.js', 'express')).toBeNull();
    });

    test('skips phantom routes.js when routes/index.js exists during repair scan', () => {
        const graph = createConsoleDeployGraph(require('path').join(__dirname, '..'));
        expect(graph.isResolvedByIndexModule('routes.js')).toBe(true);
        expect(graph.isResolvedByIndexModule('routes/auth.routes.js')).toBe(false);
    });

    test('ignores require examples inside comments when scanning dependencies', () => {
        const graph = createConsoleDeployGraph(require('path').join(__dirname, '..'));
        const required = graph.collectConsoleRequiredFiles([
            { localPath: 'scripts/linux-ensure-console-user.js' },
        ]);
        expect(required.has('scripts/linux-ensure-console-user.js')).toBe(true);
        expect(required.has('scripts/scripts/linux-ensure-console-user.js')).toBe(false);
        expect(required.has('routes.js')).toBe(false);
        expect(required.has('routes/index.js')).toBe(true);
    });

    test('collects serverAttestation from auth.routes integrity seeds', () => {
        const graph = createConsoleDeployGraph(require('path').join(__dirname, '..'));
        const required = graph.collectConsoleRequiredFiles([
            { localPath: 'routes/auth.routes.js' },
        ]);
        expect(required.has('routes/auth.routes.js')).toBe(true);
        expect(required.has('services/serverAttestation.js')).toBe(true);
    });
});
