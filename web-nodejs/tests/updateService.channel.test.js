'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { upsertEnvKey } = require('../lib/envMerge');

function loadUpdateService({ dataDir, branch }) {
    jest.resetModules();
    if (branch !== undefined) {
        process.env.UPDATE_GITHUB_BRANCH = branch;
    } else {
        delete process.env.UPDATE_GITHUB_BRANCH;
    }

    jest.doMock('../config/config', () => ({
        isDocker: false,
        dataDir,
        appVersion: '3.0.0-test',
        keysPath: path.join(dataDir, 'keys'),
    }));

    // eslint-disable-next-line global-require
    return require('../services/updateService');
}

describe('envMerge upsertEnvKey', () => {
    test('appends missing UPDATE_GITHUB_BRANCH key', () => {
        const out = upsertEnvKey('PORT=5000\n', 'UPDATE_GITHUB_BRANCH', 'dev');
        expect(out).toContain('UPDATE_GITHUB_BRANCH=dev');
    });

    test('replaces existing UPDATE_GITHUB_BRANCH key', () => {
        const out = upsertEnvKey('UPDATE_GITHUB_BRANCH=main\nPORT=5000\n', 'UPDATE_GITHUB_BRANCH', 'dev');
        expect(out).toContain('UPDATE_GITHUB_BRANCH=dev');
        expect(out).not.toMatch(/UPDATE_GITHUB_BRANCH=main/);
    });
});

describe('updateService update channel', () => {
    let tmpRoot;
    let dataDir;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-update-channel-'));
        dataDir = path.join(tmpRoot, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
    });

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../config/config');
        delete process.env.UPDATE_GITHUB_BRANCH;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('defaults to stable main branch', () => {
        const updateService = loadUpdateService({ dataDir });
        expect(updateService.getUpdateChannelInfo()).toEqual(expect.objectContaining({
            channel: 'stable',
            branch: 'main',
        }));
    });

    test('maps dev branch to development channel', () => {
        const updateService = loadUpdateService({ dataDir, branch: 'dev' });
        expect(updateService.getUpdateChannelInfo()).toMatchObject({
            channel: 'development',
            branch: 'dev',
        });
    });

    test('rejects invalid channel id', () => {
        const updateService = loadUpdateService({ dataDir });
        expect(() => updateService.setUpdateChannel('beta')).toThrow(/Invalid update channel/i);
    });

    test('UPDATE_CHANNELS exposes stable and development', () => {
        const updateService = loadUpdateService({ dataDir });
        expect(updateService.UPDATE_CHANNELS.stable.branch).toBe('main');
        expect(updateService.UPDATE_CHANNELS.development.branch).toBe('dev');
    });

    test('reports insufficient disk space before an update', () => {
        const updateService = loadUpdateService({ dataDir });
        if (typeof fs.statfsSync !== 'function') {
            expect(updateService.checkUpdateDiskSpace(dataDir).supported).toBe(false);
            return;
        }

        const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({
            bavail: 1,
            bsize: 4096,
        });
        try {
            const result = updateService.checkUpdateDiskSpace(dataDir);
            expect(result.supported).toBe(true);
            expect(result.sufficient).toBe(false);
            expect(result.availableBytes).toBe(4096);
        } finally {
            statfs.mockRestore();
        }
    });

    test('does not block updates when filesystem statistics are unusable', () => {
        const updateService = loadUpdateService({ dataDir });
        if (typeof fs.statfsSync !== 'function') return;

        const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({});
        try {
            expect(updateService.checkUpdateDiskSpace(dataDir)).toMatchObject({
                supported: false,
                sufficient: null,
                availableBytes: null,
            });
        } finally {
            statfs.mockRestore();
        }
    });

    test('preflight stays ready when server update needs Go toolchain bootstrap', async () => {
        const updateService = loadUpdateService({ dataDir });
        const prebuiltSpy = jest.spyOn(updateService, 'checkPrebuiltAvailable')
            .mockResolvedValue({ available: false });
        const goSpy = jest.spyOn(updateService, 'checkGoAvailable')
            .mockReturnValue({
                available: true,
                meetsMinimum: false,
                needsUpgrade: true,
                version: 'go version go1.20 linux/amd64',
            });
        const remoteSpy = jest.spyOn(updateService, 'getRemoteHeadSHA')
            .mockResolvedValue({ sha: 'abc123def4567890abcdef1234567890abcdef12' });

        try {
            const pf = await updateService.runUpdatePreflight({
                serverUpdateRequired: true,
                remoteSHA: 'abc123def4567890abcdef1234567890abcdef12',
            });
            expect(pf.ready).toBe(true);
            expect(pf.issues).toHaveLength(0);
            expect(pf.warnings.join(' ')).toMatch(/toolchain/i);
        } finally {
            prebuiltSpy.mockRestore();
            goSpy.mockRestore();
            remoteSpy.mockRestore();
        }
    });
});
