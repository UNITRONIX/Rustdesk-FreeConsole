'use strict';

/**
 * Regression: Tauri desktop file IPC returns base64 strings.
 * `new Uint8Array(base64String)` is length 0 in JS — that produced 0 KB remote files.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLocalFiles() {
    const sandbox = {
        console,
        Uint8Array,
        ArrayBuffer,
        btoa: typeof btoa === 'function'
            ? btoa
            : (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: typeof atob === 'function'
            ? atob
            : (s) => {
                // Match browser atob: reject invalid characters.
                if (/[^A-Za-z0-9+/=]/.test(String(s))) {
                    throw new DOMException('Invalid character', 'InvalidCharacterError');
                }
                return Buffer.from(String(s), 'base64').toString('binary');
            },
        DOMException: typeof DOMException !== 'undefined'
            ? DOMException
            : class DOMException extends Error {
                constructor(message, name) {
                    super(message);
                    this.name = name || 'Error';
                }
            },
        window: {
            __BETTERDESK_RDCLIENT_DESKTOP__: false,
            __TAURI__: null,
            isSecureContext: false,
            showDirectoryPicker: undefined
        }
    };
    sandbox.window = Object.assign(sandbox.window, sandbox);
    vm.runInNewContext(
        fs.readFileSync(
            path.join(__dirname, '..', 'public/js/rdclient/local-files.js'),
            'utf8'
        ),
        sandbox,
        { filename: 'local-files.js' }
    );
    return sandbox.window.LocalFiles;
}

describe('LocalFiles base64 IPC coercion', () => {
    let LocalFiles;

    beforeAll(() => {
        LocalFiles = loadLocalFiles();
    });

    it('documents the Uint8Array(string) trap (length 0)', () => {
        const b64 = Buffer.from('hello-file-bytes').toString('base64');
        expect(new Uint8Array(b64).length).toBe(0);
    });

    it('decodes base64 strings from desktop_read_file_chunk', () => {
        const raw = Buffer.from('hello-file-bytes');
        const b64 = raw.toString('base64');
        const out = LocalFiles.base64ToBytes(b64);
        expect(Buffer.from(out).toString()).toBe('hello-file-bytes');
    });

    it('accepts legacy number-array IPC payloads', () => {
        const out = LocalFiles.coerceBinaryPayload([72, 105]);
        expect(Array.from(out)).toEqual([72, 105]);
    });

    it('round-trips bytesToBase64 ↔ base64ToBytes', () => {
        const src = new Uint8Array([1, 2, 3, 250, 255]);
        const b64 = LocalFiles.bytesToBase64(src);
        expect(Array.from(LocalFiles.base64ToBytes(b64))).toEqual([1, 2, 3, 250, 255]);
    });

    it('rejects invalid base64 instead of returning empty', () => {
        expect(() => LocalFiles.coerceBinaryPayload('%%%not-base64%%%')).toThrow(/base64/i);
    });
});

describe('RDCompress.normalizeBytes string trap', () => {
    const fs2 = require('fs');
    const vm2 = require('vm');

    it('does not treat base64 strings as byte arrays', () => {
        const sandbox = { console, Uint8Array, ArrayBuffer };
        vm2.runInNewContext(
            fs2.readFileSync(
                path.join(__dirname, '..', 'public/js/rdclient/compress.js'),
                'utf8'
            ) + '\nglobalThis.RDCompress = RDCompress;',
            sandbox,
            { filename: 'compress.js' }
        );
        const b64 = Buffer.from('payload').toString('base64');
        expect(sandbox.RDCompress.normalizeBytes(b64).length).toBe(0);
        expect(sandbox.RDCompress.normalizeBytes([1, 2, 3]).length).toBe(3);
    });
});
