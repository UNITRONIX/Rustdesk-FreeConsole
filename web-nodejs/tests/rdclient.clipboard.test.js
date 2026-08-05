'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRdclientModules() {
    const sandbox = {
        console,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        Blob: typeof Blob !== 'undefined' ? Blob : undefined,
        DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : undefined,
        CompressionStream: typeof CompressionStream !== 'undefined' ? CompressionStream : undefined,
        Response: typeof Response !== 'undefined' ? Response : undefined,
        navigator: { clipboard: { writeText: jest.fn(), write: jest.fn() } },
        DOMParser: class {
            parseFromString(html) {
                let text = String(html);
                let prev;
                do {
                    prev = text;
                    text = text.replace(/<[^>]+>/g, '');
                } while (text !== prev);
                return { body: { textContent: text } };
            }
        },
        window: {},
        globalThis: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const base = path.join(__dirname, '..', 'public/js/rdclient');
    vm.runInNewContext(
        fs.readFileSync(path.join(base, 'compress.js'), 'utf8') + '\nglobalThis.RDCompress = RDCompress;',
        sandbox,
        { filename: 'compress.js' }
    );
    vm.runInNewContext(
        fs.readFileSync(path.join(base, 'clipboard.js'), 'utf8') + '\nglobalThis.RDClipboard = RDClipboard;',
        sandbox,
        { filename: 'clipboard.js' }
    );
    return sandbox;
}

describe('RDClipboard helpers', () => {
    let RDClipboard;
    let RDCompress;

    beforeAll(() => {
        const sandbox = loadRdclientModules();
        RDClipboard = sandbox.RDClipboard;
        RDCompress = sandbox.RDCompress;
    });

    it('skips RustDesk owner special format', () => {
        expect(RDClipboard.shouldSkipEntry({
            format: 'Special',
            specialName: 'dyn.com.rustdesk.owner',
            content: new Uint8Array([1, 2, 3])
        })).toBe(true);
        expect(RDClipboard.shouldSkipEntry({
            format: 31,
            special_name: 'XML Spreadsheet',
            content: new Uint8Array([1])
        })).toBe(false);
    });

    it('stripHtml removes tags and keeps text', () => {
        expect(RDClipboard.stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
    });

    it('pickBestText prefers Text over Html and Rtf', () => {
        const entries = [
            { format: 'html', text: 'html plain', html: '<i>x</i>' },
            { format: 'text', text: 'plain text' },
            { format: 'rtf', text: 'rtf plain' }
        ];
        expect(RDClipboard.pickBestText(entries)).toBe('plain text');
        expect(RDClipboard.pickBestText([
            { format: 'html', text: 'from html', html: '<b>x</b>' },
            { format: 'rtf', text: 'from rtf' }
        ])).toBe('from html');
    });

    it('decodeEntry returns UTF-8 text when not compressed', async () => {
        const text = 'Remote clipboard line';
        const decoded = await RDClipboard.decodeEntry({
            compress: false,
            format: 'Text',
            content: new TextEncoder().encode(text)
        });
        expect(decoded).toEqual({ format: 'text', text });
    });

    it('decodeEntries ignores owner special entries', async () => {
        const decoded = await RDClipboard.decodeEntries([
            {
                compress: false,
                format: 'Special',
                specialName: 'dyn.com.rustdesk.owner',
                content: new Uint8Array([9, 9, 9])
            },
            {
                compress: false,
                format: 'Text',
                content: new TextEncoder().encode('kept')
            }
        ]);
        expect(decoded).toHaveLength(1);
        expect(decoded[0].text).toBe('kept');
    });

    it('applyToLocal returns wrote=true when writeText succeeds', async () => {
        const sandbox = loadRdclientModules();
        const writeText = sandbox.navigator.clipboard.writeText;
        writeText.mockResolvedValue(undefined);
        const result = await sandbox.RDClipboard.applyToLocal(
            [{ format: 'text', text: 'remote line' }],
            { enabled: true }
        );
        expect(result).toEqual({ wrote: true, text: 'remote line' });
        expect(writeText).toHaveBeenCalledWith('remote line');
    });

    it('applyToLocal returns wrote=false and stashes text when write fails', async () => {
        const sandbox = loadRdclientModules();
        sandbox.navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
        const result = await sandbox.RDClipboard.applyToLocal(
            [{ format: 'text', text: 'stash me' }],
            { enabled: true }
        );
        expect(result.wrote).toBe(false);
        expect(result.text).toBe('stash me');
    });
});

describe('RDCompress helpers', () => {
    let RDCompress;

    beforeAll(() => {
        RDCompress = loadRdclientModules().RDCompress;
    });

    it('detects zstd magic bytes', () => {
        expect(RDCompress.isZstdMagic(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]))).toBe(true);
        expect(RDCompress.isZstdMagic(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    });

    it('returns raw bytes when not compressed and force is false', async () => {
        const raw = new Uint8Array([72, 105]);
        const out = await RDCompress.decompressZstd(raw);
        expect(Array.from(out)).toEqual([72, 105]);
    });
});

describe('RDClient clipboard protobuf field', () => {
    const protobuf = require('protobufjs');

    it('round-trips multi_clipboards on Message', async () => {
        const root = await protobuf.load([
            path.join(__dirname, '../protos/message.proto')
        ]);
        const Message = root.lookupType('hbb.Message');
        const msg = Message.create({
            multiClipboards: {
                clipboards: [{
                    compress: false,
                    format: 0,
                    content: Buffer.from('hello', 'utf8')
                }]
            }
        });
        const decoded = Message.decode(Message.encode(msg).finish());
        expect(decoded.multiClipboards.clipboards).toHaveLength(1);
        expect(Buffer.from(decoded.multiClipboards.clipboards[0].content).toString('utf8')).toBe('hello');
    });
});
