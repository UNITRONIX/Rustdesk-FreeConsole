'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCursorModules() {
    class FakeImageData {
        constructor(data, width, height) {
            this.data = data;
            this.width = width;
            this.height = height;
        }
    }

    const sandbox = {
        console,
        document: {
            createElement(tag) {
                if (tag !== 'canvas') return {};
                return {
                    width: 0,
                    height: 0,
                    style: { cursor: '' },
                    getContext() {
                        return { putImageData() {} };
                    },
                    toDataURL() {
                        return 'data:image/png;base64,TEST';
                    },
                };
            },
        },
        window: {},
        globalThis: {},
        ImageData: FakeImageData,
        Uint8Array,
        Uint8ClampedArray,
        Blob: typeof Blob !== 'undefined' ? Blob : undefined,
        DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : undefined,
        CompressionStream: typeof CompressionStream !== 'undefined' ? CompressionStream : undefined,
        Response: typeof Response !== 'undefined' ? Response : undefined,
        createImageBitmap: async () => ({ close() {} }),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const base = path.join(__dirname, '..', 'public/js/rdclient');
    vm.runInNewContext(
        fs.readFileSync(path.join(base, 'compress.js'), 'utf8')
            + '\nglobalThis.RDCompress = RDCompress; window.RDCompress = RDCompress;',
        sandbox,
        { filename: 'compress.js' }
    );
    vm.runInNewContext(
        fs.readFileSync(path.join(base, 'renderer.js'), 'utf8'),
        sandbox,
        { filename: 'renderer.js' }
    );

    return sandbox;
}

function makeRgba(w, h, fill) {
    const bytes = new Uint8Array(w * h * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = fill[i % 4];
    return bytes;
}

describe('RDRenderer cursor handling', () => {
    let RDRenderer;
    let RDCompress;
    let mainCanvas;

    beforeEach(() => {
        const sandbox = loadCursorModules();
        RDRenderer = sandbox.RDRenderer;
        RDCompress = sandbox.RDCompress;
        mainCanvas = {
            width: 100,
            height: 100,
            style: { cursor: '' },
            parentElement: null,
            getContext() {
                return {
                    fillRect() {},
                    drawImage() {},
                    fillStyle: '',
                };
            },
        };
    });

    it('cursorCacheKey normalizes Long-like ids', () => {
        expect(RDRenderer.cursorCacheKey(42)).toBe('42');
        expect(RDRenderer.cursorCacheKey({ toString: () => '99' })).toBe('99');
        expect(RDRenderer.cursorCacheKey(null)).toBe(null);
    });

    it('applies CSS cursor from uncompressed CursorData and caches by id', async () => {
        const renderer = new RDRenderer(mainCanvas);
        const colors = makeRgba(2, 2, [255, 0, 0, 255]);

        await renderer.updateCursor({
            id: 7,
            width: 2,
            height: 2,
            hotx: 1,
            hoty: 0,
            colors,
        });

        expect(mainCanvas.style.cursor).toContain('url(');
        expect(mainCanvas.style.cursor).toContain('1 0');
        expect(renderer.setCursorById(7)).toBe(true);
        expect(renderer.setCursorById(999)).toBe(false);
        expect(renderer.cursorHotspot).toEqual({ x: 1, y: 0 });
    });

    it('decompresses zstd CursorData before applying (RustDesk wire format)', async () => {
        const renderer = new RDRenderer(mainCanvas);
        const raw = makeRgba(2, 2, [0, 255, 0, 255]);
        // Synthetic zstd magic — Node often lacks CompressionStream('zstd')
        const fakeZstd = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x10, 0x00]);
        expect(RDCompress.isZstdMagic(fakeZstd)).toBe(true);

        const orig = RDCompress.decompressZstd.bind(RDCompress);
        RDCompress.decompressZstd = async (data) => {
            const bytes = RDCompress.normalizeBytes(data);
            if (RDCompress.isZstdMagic(bytes)) return raw;
            return orig(data);
        };

        try {
            await renderer.updateCursor({
                id: 11,
                width: 2,
                height: 2,
                hotx: 0,
                hoty: 0,
                colors: fakeZstd,
            });
        } finally {
            RDCompress.decompressZstd = orig;
        }

        expect(mainCanvas.style.cursor).toContain('url(');
        expect(renderer.setCursorById(11)).toBe(true);
    });

    it('switches CSS cursor on cursor_id cache hit', async () => {
        const renderer = new RDRenderer(mainCanvas);

        await renderer.updateCursor({
            id: 1,
            width: 2,
            height: 2,
            hotx: 0,
            hoty: 0,
            colors: makeRgba(2, 2, [255, 0, 0, 255]),
        });
        const first = mainCanvas.style.cursor;

        await renderer.updateCursor({
            id: 2,
            width: 2,
            height: 2,
            hotx: 1,
            hoty: 1,
            colors: makeRgba(2, 2, [0, 0, 255, 255]),
        });
        const second = mainCanvas.style.cursor;
        expect(second).not.toBe(first);

        expect(renderer.setCursorById(1)).toBe(true);
        expect(mainCanvas.style.cursor).toBe(first);
        expect(renderer.cursorHotspot).toEqual({ x: 0, y: 0 });
    });
});
