'use strict';

const fs = require('fs');
const os = require('os');
const { PNG } = require('pngjs');

describe('Real Client private PNG assets', () => {
    let root;
    let service;

    beforeEach(() => {
        root = fs.mkdtempSync(`${os.tmpdir()}/bd-real-client-assets-`);
        process.env.DATA_DIR = root;
        jest.resetModules();
        service = require('../services/realClientAssetService');
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        fs.rmSync(root, { recursive: true, force: true });
    });

    function png(width, height) {
        return PNG.sync.write(new PNG({ width, height }));
    }

    test('fully decodes PNG data and enforces square icons', async () => {
        const saved = await service.saveAsset({ ownerUserId: 5, kind: 'icon', buffer: png(16, 16), originalName: 'icon.png' });
        expect(saved).toEqual(expect.objectContaining({ width: 16, height: 16, kind: 'icon' }));
        const loaded = await service.readAsset({ ownerUserId: 5, id: saved.id, kind: 'icon' });
        expect(loaded.buffer.length).toBe(saved.size);
        await expect(service.saveAsset({ ownerUserId: 5, kind: 'icon', buffer: png(16, 8) })).rejects.toThrow('square');
    });

    test('rejects a header-only or corrupt PNG', () => {
        const corrupt = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
        expect(() => service.validatePng(corrupt, 'logo')).toThrow(/valid PNG|corrupt/i);
    });
});
