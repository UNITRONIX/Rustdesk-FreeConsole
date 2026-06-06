'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadUpdateService({ dataDir, imageSha }) {
    jest.resetModules();
    if (imageSha) process.env.BETTERDESK_IMAGE_SHA = imageSha;
    process.env.BETTERDESK_UPDATE_MODE = 'image';

    jest.doMock('../config/config', () => ({
        isDocker: true,
        dataDir,
        appVersion: '3.0.0-test'
    }));

    // eslint-disable-next-line global-require
    return require('../services/updateService');
}

describe('updateService docker image deployment', () => {
    let tmpRoot;
    let dataDir;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-docker-update-'));
        dataDir = path.join(tmpRoot, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        delete process.env.BETTERDESK_IMAGE_SHA;
    });

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../config/config');
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('uses embedded image SHA and disables stale-binary warnings', () => {
        const imageSha = 'abc123def4567890abcdef1234567890abcdef';
        fs.writeFileSync(path.join(dataDir, '.update_sha'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
        fs.writeFileSync(path.join(dataDir, '.server_binary_stale'), JSON.stringify({ stale: true }));

        const updateService = loadUpdateService({ dataDir, imageSha });

        expect(updateService.isImageBasedDockerDeployment()).toBe(true);
        expect(updateService.getImageEmbeddedSHA()).toBe(imageSha);
        expect(updateService.getLocalSHA()).toBe(imageSha);
        expect(updateService.getServerBinaryStatus()).toEqual({ stale: false, dockerMode: true });
        expect(fs.existsSync(path.join(dataDir, '.server_binary_stale'))).toBe(false);
    });

    test('applyUpdate rejects in-app installs', async () => {
        const updateService = loadUpdateService({
            dataDir,
            imageSha: 'abc123def4567890abcdef1234567890abcdef'
        });

        await expect(updateService.applyUpdate('abc1234', { grouped: {} }))
            .rejects
            .toThrow(/disabled in Docker image deployments/i);
    });

    test('rebuildServerBinary returns docker guidance', async () => {
        const updateService = loadUpdateService({
            dataDir,
            imageSha: 'abc123def4567890abcdef1234567890abcdef'
        });

        const result = await updateService.rebuildServerBinary();
        expect(result.success).toBe(false);
        expect(result.dockerMode).toBe(true);
        expect(result.error).toMatch(/not available in Docker/i);
    });
});
