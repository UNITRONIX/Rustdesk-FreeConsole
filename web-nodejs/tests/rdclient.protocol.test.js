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
});
