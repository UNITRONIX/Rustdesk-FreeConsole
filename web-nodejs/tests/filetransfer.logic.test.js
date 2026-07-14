'use strict';

const { RDFileTransfer } = require('../public/js/rdclient/filetransfer.js');

describe('RDFileTransfer static helpers', () => {
    it('uses 128 KB block size (hbb_common parity)', () => {
        const ft = new RDFileTransfer({
            proto: {},
            sendMessage: () => {},
            emit: () => {}
        });
        expect(ft.BLOCK_SIZE).toBe(131072);
    });

    it('computeOffsetBlk derives block index from transferred bytes', () => {
        expect(RDFileTransfer.computeOffsetBlk(0, 131072)).toBe(0);
        expect(RDFileTransfer.computeOffsetBlk(131072, 131072)).toBe(1);
        expect(RDFileTransfer.computeOffsetBlk(262144, 131072)).toBe(2);
    });

    it('isPreCompressedFileName skips zstd for archives and media', () => {
        expect(RDFileTransfer.isPreCompressedFileName('photo.jpg')).toBe(true);
        expect(RDFileTransfer.isPreCompressedFileName('archive.zip')).toBe(true);
        expect(RDFileTransfer.isPreCompressedFileName('readme.txt')).toBe(false);
        expect(RDFileTransfer.isPreCompressedFileName('data.bin')).toBe(false);
    });

    it('buildRemoteFilePath joins Windows and Unix paths', () => {
        expect(RDFileTransfer.buildRemoteFilePath('C:\\Users\\admin', 'test.txt'))
            .toBe('C:\\Users\\admin\\test.txt');
        expect(RDFileTransfer.buildRemoteFilePath('/home/user/', 'a.bin'))
            .toBe('/home/user/a.bin');
    });
});

describe('RDFileTransfer overwrite strategy', () => {
    it('confirmOverwrite resolves pending prompt and sets session strategy', () => {
        const ft = new RDFileTransfer({
            proto: {},
            sendMessage: () => {},
            emit: () => {}
        });
        let skipped = null;
        ft._pendingOverwrite.set(1, {
            resolve: (s) => { skipped = s; }
        });
        ft.confirmOverwrite(1, false, true);
        expect(skipped).toBe(false);
        expect(ft._overwriteStrategy).toBe('overwrite');
        expect(ft._pendingOverwrite.has(1)).toBe(false);
    });
});

describe('RDFileTransfer dedicated connection', () => {
    it('waits for the file relay before sending a directory request', async () => {
        let resolveConnection;
        const ensureConnected = jest.fn(() => new Promise(resolve => { resolveConnection = resolve; }));
        const sendMessage = jest.fn();
        const emit = jest.fn();
        const ft = new RDFileTransfer({
            proto: { buildReadDir: (path, showHidden) => ({ readDir: { path, showHidden } }) },
            sendMessage,
            emit,
            ensureConnected,
            isConnected: () => false,
        });
        ft.enable();

        ft.browseDir('C:\\Users');
        expect(ensureConnected).toHaveBeenCalledTimes(1);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(emit).toHaveBeenCalledWith('file_connecting');

        resolveConnection();
        await new Promise(resolve => setImmediate(resolve));

        expect(sendMessage).toHaveBeenCalledWith({
            readDir: { path: 'C:\\Users', showHidden: false }
        });
        clearTimeout(ft._browseTimeout);
    });

    it('reports connection errors instead of throwing from the click handler', async () => {
        const emit = jest.fn();
        const ft = new RDFileTransfer({
            proto: { buildReadDir: jest.fn() },
            sendMessage: jest.fn(),
            emit,
            ensureConnected: () => Promise.reject(new Error('relay unavailable')),
            isConnected: () => false,
        });
        ft.enable();

        expect(() => ft.browseDir('')).not.toThrow();
        await new Promise(resolve => setImmediate(resolve));

        expect(emit).toHaveBeenCalledWith('file_connect_error', { error: 'relay unavailable' });
    });
});
