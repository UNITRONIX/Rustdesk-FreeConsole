'use strict';

const {
    GITHUB_COMPARE_FILE_LIMIT,
    isCompareLikelyTruncated,
    resolveConsoleRequire,
    collectConsoleRequiredFiles
} = require('../services/updateService');

describe('updateService console sync helpers', () => {
    test('detects truncated GitHub compare responses', () => {
        expect(GITHUB_COMPARE_FILE_LIMIT).toBe(300);
        expect(isCompareLikelyTruncated(299)).toBe(false);
        expect(isCompareLikelyTruncated(300)).toBe(true);
        expect(isCompareLikelyTruncated(450)).toBe(true);
    });

    test('resolves relative console require paths', () => {
        expect(resolveConsoleRequire('routes/auth.routes.js', '../services/serverAttestation'))
            .toBe('services/serverAttestation.js');
        expect(resolveConsoleRequire('routes/index.js', './devices.routes'))
            .toBe('routes/devices.routes.js');
        expect(resolveConsoleRequire('server.js', './routes'))
            .toBe('routes/index.js');
        expect(resolveConsoleRequire('server.js', 'express')).toBeNull();
    });

    test('skips phantom routes.js when routes/index.js exists during repair scan', () => {
        const { isResolvedByIndexModule } = require('../services/updateService');
        expect(isResolvedByIndexModule('routes.js')).toBe(true);
        expect(isResolvedByIndexModule('routes/auth.routes.js')).toBe(false);
    });

    test('ignores require examples inside comments when scanning dependencies', () => {
        const required = collectConsoleRequiredFiles([
            { localPath: 'scripts/linux-ensure-console-user.js' }
        ]);
        expect(required.has('scripts/linux-ensure-console-user.js')).toBe(true);
        expect(required.has('scripts/scripts/linux-ensure-console-user.js')).toBe(false);
        expect(required.has('routes.js')).toBe(false);
        expect(required.has('routes/index.js')).toBe(true);
    });

    test('collects serverAttestation from auth.routes integrity seeds', () => {
        const required = collectConsoleRequiredFiles([
            { localPath: 'routes/auth.routes.js' }
        ]);
        expect(required.has('routes/auth.routes.js')).toBe(true);
        expect(required.has('services/serverAttestation.js')).toBe(true);
    });
});
