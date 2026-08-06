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

    it('buildRemoteRelativePath nests folders with remote separators', () => {
        expect(RDFileTransfer.buildRemoteRelativePath('C:\\Users\\admin', 'docs/a.txt'))
            .toBe('C:\\Users\\admin\\docs\\a.txt');
        expect(RDFileTransfer.buildRemoteRelativePath('/home/user', 'docs/sub/a.bin'))
            .toBe('/home/user/docs/sub/a.bin');
        expect(RDFileTransfer.buildRemoteRelativePath('/tmp', '')).toBe('/tmp');
    });

    it('joinLocalPath builds nested local paths', () => {
        expect(RDFileTransfer.joinLocalPath('C:\\Downloads', 'proj/readme.txt'))
            .toBe('C:\\Downloads\\proj\\readme.txt');
        expect(RDFileTransfer.joinLocalPath('/home/me/dl', 'proj/readme.txt'))
            .toBe('/home/me/dl/proj/readme.txt');
        expect(RDFileTransfer.joinLocalPath('/tmp/out', '')).toBe('/tmp/out');
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

describe('RDFileTransfer folder job queue', () => {
    it('queues a second folder job while one is active', () => {
        const ft = new RDFileTransfer({
            proto: {
                buildFileDirCreate: () => ({}),
                buildReadDir: () => ({}),
                buildFileReceiveRequest: () => ({}),
                buildFileDigest: () => ({}),
                buildFileCancel: () => ({})
            },
            sendMessage: () => {},
            emit: () => {}
        });
        ft.enable();
        // Prevent createDirAsync from hanging on real connection hooks.
        ft.createDirAsync = async () => {};
        ft.uploadFile = () => {
            const id = ft._nextId++;
            const transfer = {
                id,
                type: 'upload',
                folderJobId: ft._activeFolderJob && ft._activeFolderJob.id,
                _folderWait: null,
                status: 'pending'
            };
            ft._transfers.set(id, transfer);
            // Never resolve — keeps first job active.
            return id;
        };

        const id1 = ft.uploadFolder({
            rootName: 'a',
            dirs: [],
            files: [{ name: '1.txt', relativePath: '1.txt', size: 1, file: { name: '1.txt', size: 1 } }]
        }, '/remote');
        const id2 = ft.uploadFolder({
            rootName: 'b',
            dirs: [],
            files: [{ name: '2.txt', relativePath: '2.txt', size: 1, file: { name: '2.txt', size: 1 } }]
        }, '/remote');

        expect(id1).toBeGreaterThan(0);
        expect(id2).toBeGreaterThan(0);
        expect(ft._activeFolderJob).toBeTruthy();
        expect(ft._activeFolderJob.id).toBe(id1);
        expect(ft._folderJobQueue.length).toBe(1);
        expect(ft._folderJobQueue[0].id).toBe(id2);

        ft.cancelTransfer(id2);
        expect(ft._folderJobQueue.length).toBe(0);
        ft.cancelTransfer(id1);
        expect(ft._activeFolderJob).toBeNull();
    });

    it('background readDirAsync resolves from FileResponse.dir without clobbering UI path', async () => {
        const ft = new RDFileTransfer({
            proto: {
                buildReadDir: (path) => ({ fileAction: { readDir: { path } } })
            },
            sendMessage: () => {},
            emit: () => {}
        });
        ft.enable();
        ft._currentPath = '/keep';
        const pending = ft.readDirAsync('/walk');
        ft.handleFileResponse({
            dir: {
                path: '/walk',
                entries: [
                    { name: 'f.txt', entryType: 4, size: 3, modifiedTime: 1 }
                ]
            }
        });
        const entries = await pending;
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('f.txt');
        expect(ft.currentPath).toBe('/keep');
    });
});
