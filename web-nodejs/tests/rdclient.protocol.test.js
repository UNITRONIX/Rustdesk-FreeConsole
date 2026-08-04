/**
 * Regression: Auth2FA must serialize under auth_2fa (not auth2Fa).
 * Wrong field names produce empty Message payloads — peer never receives the code.
 *
 * FILE_TRANSFER: dedicated relay session uses ConnType.FILE_TRANSFER and
 * LoginRequest.file_transfer union — required for RustDesk file manager (#217).
 */
const protobuf = require('protobufjs');
const path = require('path');

describe('RDClient Auth2FA protobuf encoding', () => {
    let Message;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
    });

    it('encodes auth_2fa with a non-empty payload', () => {
        const msg = Message.fromObject({ auth_2fa: { code: '741626' } });
        const buf = Message.encode(msg).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = Message.decode(buf).toJSON();
        expect(decoded.auth_2fa).toEqual({ code: '741626' });
    });

    it('does not encode auth2Fa camelCase alias (protobuf.js quirk)', () => {
        const msg = Message.fromObject({ auth2Fa: { code: '741626' } });
        const buf = Message.encode(msg).finish();
        expect(buf.length).toBe(0);
    });
});

describe('RDClient FILE_TRANSFER protobuf encoding', () => {
    let RendezvousMessage;
    let Message;
    let ConnType;
    let LoginRequest;

    beforeAll(async () => {
        const rendezvousRoot = await protobuf.load([
            path.join(__dirname, '../protos/rendezvous.proto')
        ]);
        RendezvousMessage = rendezvousRoot.lookupType('hbb.RendezvousMessage');
        ConnType = rendezvousRoot.lookupEnum('hbb.ConnType');

        const messageRoot = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = messageRoot.lookupType('hbb.Message');
        LoginRequest = messageRoot.lookupType('hbb.LoginRequest');
    });

    it('encodes PunchHoleRequest with FILE_TRANSFER conn_type', () => {
        const msg = RendezvousMessage.create({
            punchHoleRequest: {
                id: '1234567',
                natType: 0,
                licenceKey: 'test-key',
                connType: ConnType.values.FILE_TRANSFER,
                forceRelay: true
            }
        });
        const buf = RendezvousMessage.encode(msg).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = RendezvousMessage.decode(buf).toJSON();
        expect(decoded.punchHoleRequest.connType).toBe('FILE_TRANSFER');
    });

    it('encodes LoginRequest with fileTransfer union (not empty payload)', () => {
        const login = LoginRequest.create({
            username: '',
            password: Buffer.from([1, 2, 3, 4]),
            myId: 'web-client-ft',
            myName: 'BetterDesk Web',
            fileTransfer: { dir: '', showHidden: false }
        });
        const buf = LoginRequest.encode(login).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = LoginRequest.decode(buf).toJSON();
        expect(decoded.fileTransfer).toEqual({ dir: '', showHidden: false });
    });

    it('regression: empty LoginRequest without fileTransfer union', () => {
        const login = LoginRequest.create({
            password: Buffer.from([1, 2, 3, 4])
        });
        const decoded = LoginRequest.decode(LoginRequest.encode(login).finish()).toJSON();
        expect(decoded.fileTransfer).toBeUndefined();
    });
});

describe('RDClient file transfer message encoding', () => {
    let Message;
    let FileEntry;
    let FileAction;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
        FileEntry = root.lookupType('hbb.FileEntry');
        FileAction = root.lookupType('hbb.FileAction');
    });

    function buildRemoteUploadPath(remoteDir, fileName) {
        const dir = remoteDir || '';
        const sep = dir.includes('\\') ? '\\' : '/';
        if (!dir) return fileName || '';
        return dir + (dir.endsWith(sep) ? '' : sep) + (fileName || '');
    }

    it('buildRemoteUploadPath joins directory and file name', () => {
        expect(buildRemoteUploadPath('C:\\Users\\admin', 'test.txt')).toBe('C:\\Users\\admin\\test.txt');
        expect(buildRemoteUploadPath('/home/user/', 'a.bin')).toBe('/home/user/a.bin');
        expect(buildRemoteUploadPath('', 'only.txt')).toBe('only.txt');
    });

    it('encodes FileTransferReceiveRequest for upload to remote (dir + files)', () => {
        const entry = FileEntry.create({
            entryType: 4,
            name: 'readme.txt',
            size: 42,
            modifiedTime: 1700000000
        });
        const action = FileAction.create({
            receive: {
                id: 7,
                path: 'C:\\Users\\admin',
                files: [entry],
                fileNum: 0,
                totalSize: 42
            }
        });
        const buf = FileAction.encode(action).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = FileAction.decode(buf).toJSON();
        expect(decoded.receive.path).toBe('C:\\Users\\admin');
        expect(decoded.receive.files).toHaveLength(1);
        expect(decoded.receive.files[0].name).toBe('readme.txt');
        expect(decoded.receive.files[0].entryType).toBe('File');
    });

    it('encodes FileTransferSendRequest for download from remote (full file path)', () => {
        const fullPath = buildRemoteUploadPath('C:\\Users\\admin', 'readme.txt');
        const action = FileAction.create({
            send: {
                id: 3,
                path: fullPath,
                includeHidden: false,
                fileNum: 0
            }
        });
        const buf = FileAction.encode(action).finish();
        expect(buf.length).toBeGreaterThan(0);

        const decoded = FileAction.decode(buf).toJSON();
        expect(decoded.send.path).toBe('C:\\Users\\admin\\readme.txt');
    });

    it('wraps file_action in Message for peer relay', () => {
        const msg = Message.create({
            fileAction: {
                send: { id: 1, path: '/tmp/x.dat', includeHidden: false, fileNum: 0 }
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish()).toJSON();
        expect(decoded.fileAction.send.path).toBe('/tmp/x.dat');
    });

    it('encodes FileResponse.digest for upload (operator sends metadata first)', () => {
        const msg = Message.create({
            fileResponse: {
                digest: {
                    id: 5,
                    fileNum: 0,
                    fileSize: 12345,
                    lastModified: 1700000000
                }
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish()).toJSON();
        expect(decoded.fileResponse.digest.fileSize).toBe('12345');
        expect(decoded.fileResponse.digest.lastModified).toBe('1700000000');
    });

    it('encodes FileResponse.digest with resume fields', () => {
        const msg = Message.create({
            fileResponse: {
                digest: {
                    id: 9,
                    fileNum: 0,
                    fileSize: 999999,
                    lastModified: 1700000001,
                    isResume: true,
                    transferredSize: 131072
                }
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish()).toJSON();
        expect(decoded.fileResponse.digest.isResume).toBe(true);
        expect(decoded.fileResponse.digest.transferredSize).toBe('131072');
    });

    it('encodes FileAction.send_confirm with offset_blk for resume', () => {
        const action = FileAction.create({
            sendConfirm: { id: 2, fileNum: 0, offsetBlk: 4 }
        });
        const decoded = FileAction.decode(FileAction.encode(action).finish()).toJSON();
        expect(decoded.sendConfirm.offsetBlk).toBe(4);
    });
    it('encodes FileResponse.block with non-empty bytes payload', () => {
        const payload = Buffer.from('file-block-contents');
        const msg = Message.fromObject({
            fileResponse: {
                block: {
                    id: 1,
                    fileNum: 0,
                    data: payload,
                    compressed: false,
                    blkId: 0
                }
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish());
        expect(Buffer.from(decoded.fileResponse.block.data).toString()).toBe('file-block-contents');
    });

    it('encodes FileResponse.block empty when data is mistaken base64 string via Uint8Array trap', () => {
        // Documents the IPC bug: new Uint8Array(base64String) → length 0 → empty remote file.
        const b64 = Buffer.from('file-block-contents').toString('base64');
        expect(new Uint8Array(b64).length).toBe(0);
        const msg = Message.fromObject({
            fileResponse: {
                block: {
                    id: 1,
                    fileNum: 0,
                    data: new Uint8Array(b64),
                    compressed: false,
                    blkId: 0
                }
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish());
        expect(decoded.fileResponse.block.data.length).toBe(0);
    });
});

describe('RDClient KeyEvent protobuf encoding', () => {
    let Message;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
    });

    it('encodes Map scancode keyEvent with mode Map', () => {
        const buf = Message.encode(Message.fromObject({
            keyEvent: { chr: 0x1E, down: true, press: false, modifiers: [], mode: 'Map' },
        })).finish();
        expect(buf.length).toBeGreaterThan(0);
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.keyEvent.chr).toBe(30);
        expect(decoded.keyEvent.mode).toBe('Map');
    });

    it('encodes Legacy controlKey with string enum name', () => {
        const buf = Message.encode(Message.fromObject({
            keyEvent: {
                controlKey: 'Shift',
                down: true,
                press: false,
                modifiers: [],
                mode: 'Legacy',
            },
        })).finish();
        expect(buf.length).toBeGreaterThan(0);
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.keyEvent.controlKey).toBe('Shift');
        expect(decoded.keyEvent.mode).toBe('Legacy');
    });

    it('encodes Legacy chr with CapsLock modifier', () => {
        const buf = Message.encode(Message.fromObject({
            keyEvent: {
                chr: 97,
                down: true,
                press: false,
                modifiers: ['CapsLock'],
                mode: 'Legacy',
            },
        })).finish();
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.keyEvent.modifiers).toEqual(['CapsLock']);
    });

    it('does not encode control_key snake_case alias on KeyEvent', () => {
        const buf = Message.encode(Message.fromObject({
            keyEvent: { control_key: 'Shift', down: true, mode: 'Legacy' },
        })).finish();
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.keyEvent?.controlKey).toBeUndefined();
    });

    it('create() leaves controlKey as Unknown (regression guard)', () => {
        const msg = Message.create({
            keyEvent: { controlKey: 'Shift', down: true, mode: 'Legacy' },
        });
        const decoded = Message.decode(Message.encode(msg).finish()).toJSON();
        expect(decoded.keyEvent.controlKey).toBe('Unknown');
    });
});

describe('RDClient SupportedEncoding protobuf encoding', () => {
    let Message;
    let SupportedEncoding;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
        SupportedEncoding = root.lookupType('hbb.SupportedEncoding');
    });

    it('encodes Misc.supported_encoding with codec flags', () => {
        const enc = SupportedEncoding.fromObject({
            h264: true,
            h265: true,
            vp8: false,
            av1: true,
            i444: { h264: false, h265: false, vp8: false, vp9: false, av1: false }
        });
        const buf = Message.encode(Message.fromObject({
            misc: { supportedEncoding: enc }
        })).finish();
        expect(buf.length).toBeGreaterThan(0);
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.misc.supportedEncoding.h264).toBe(true);
        expect(decoded.misc.supportedEncoding.h265).toBe(true);
        expect(decoded.misc.supportedEncoding.av1).toBe(true);
    });

    it('encodes Misc.selected_sid for Windows session switch', () => {
        const buf = Message.encode(Message.fromObject({
            misc: { selectedSid: 2 }
        })).finish();
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.misc.selectedSid).toBe(2);
    });
});

describe('RDClient Cliprdr protobuf encoding', () => {
    let Message;

    beforeAll(async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        Message = root.lookupType('hbb.Message');
    });

    it('encodes FormatDataRequest', () => {
        const buf = Message.encode(Message.fromObject({
            cliprdr: { formatDataRequest: { requestedFormatId: 49334 } }
        })).finish();
        expect(buf.length).toBeGreaterThan(0);
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.cliprdr.formatDataRequest.requestedFormatId).toBe(49334);
    });

    it('encodes FileContentsRequest range', () => {
        const buf = Message.encode(Message.fromObject({
            cliprdr: {
                fileContentsRequest: {
                    streamId: 7,
                    listIndex: 1,
                    dwFlags: 2,
                    nPositionLow: 100,
                    nPositionHigh: 0,
                    cbRequested: 65536
                }
            }
        })).finish();
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.cliprdr.fileContentsRequest.streamId).toBe(7);
        expect(decoded.cliprdr.fileContentsRequest.listIndex).toBe(1);
        expect(decoded.cliprdr.fileContentsRequest.dwFlags).toBe(2);
        expect(decoded.cliprdr.fileContentsRequest.cbRequested).toBe(65536);
    });

    it('encodes FormatList with file formats', () => {
        const buf = Message.encode(Message.fromObject({
            cliprdr: {
                formatList: {
                    formats: [
                        { id: 49334, format: 'FileGroupDescriptorW' },
                        { id: 49267, format: 'FileContents' }
                    ]
                }
            }
        })).finish();
        const decoded = Message.decode(buf).toJSON();
        expect(decoded.cliprdr.formatList.formats).toHaveLength(2);
        expect(decoded.cliprdr.formatList.formats[0].format).toBe('FileGroupDescriptorW');
    });
});
