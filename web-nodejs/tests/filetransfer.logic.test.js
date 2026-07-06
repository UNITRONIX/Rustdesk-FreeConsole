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
