'use strict';

const { createConsoleDeployGraph } = require('../lib/consoleDeployGraph');
const {
    GITHUB_COMPARE_FILE_LIMIT,
    isCompareLikelyTruncated,
    isRetryableDownloadStatus,
    getDownloadRetryDelayMs,
    ensureGoServerSignalRelayPorts,
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

    test('retries GitHub raw downloads on rate limit status codes', () => {
        expect(isRetryableDownloadStatus(429)).toBe(true);
        expect(isRetryableDownloadStatus(503)).toBe(true);
        expect(isRetryableDownloadStatus(404)).toBe(false);
        expect(getDownloadRetryDelayMs(1)).toBe(1000);
        expect(getDownloadRetryDelayMs(2)).toBe(2000);
        expect(getDownloadRetryDelayMs(6)).toBe(15000);
    });

    test('ensureGoServerSignalRelayPorts adds SIGNAL_PORT, RELAY_PORT, and GO_API_PORT (#219)', () => {
        const unit = [
            '[Service]',
            'User=root',
            'Environment=AUTH_DB_PATH=/opt/console/data/auth.db',
            'ExecStart=/opt/betterdesk/betterdesk-server -mode all',
        ].join('\n');
        const patched = ensureGoServerSignalRelayPorts(unit);
        expect(patched.changed).toBe(true);
        expect(patched.text).toMatch(/^Environment=SIGNAL_PORT=21116$/m);
        expect(patched.text).toMatch(/^Environment=RELAY_PORT=21117$/m);
        expect(patched.text).toMatch(/^Environment=GO_API_PORT=21114$/m);

        const again = ensureGoServerSignalRelayPorts(patched.text);
        expect(again.changed).toBe(false);
    });
});
