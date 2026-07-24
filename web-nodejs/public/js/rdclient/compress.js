/**
 * BetterDesk Web Remote Client - zstd compression helpers
 * Shared by file transfer and clipboard sync (RustDesk wire format).
 */

// eslint-disable-next-line no-unused-vars
class RDCompress {
    /**
     * @param {Uint8Array|ArrayBuffer|Array} data
     * @returns {Uint8Array}
     */
    static normalizeBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (data && data.length != null) return new Uint8Array(data);
        return new Uint8Array(0);
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    static isZstdMagic(bytes) {
        return bytes.length >= 4
            && bytes[0] === 0x28
            && bytes[1] === 0xb5
            && bytes[2] === 0x2f
            && bytes[3] === 0xfd;
    }

    /**
     * Decompress RustDesk zstd payload.
     * @param {Uint8Array|ArrayBuffer|Array} data
     * @param {Object} [opts]
     * @param {boolean} [opts.force] - decompress even without magic bytes
     * @returns {Promise<Uint8Array>}
     */
    static async decompressZstd(data, opts) {
        const options = opts || {};
        const bytes = RDCompress.normalizeBytes(data);
        if (!bytes.length) return bytes;

        const force = !!options.force;
        if (!force && !RDCompress.isZstdMagic(bytes)) {
            return bytes;
        }

        if (typeof DecompressionStream === 'function') {
            try {
                const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('zstd'));
                const out = await new Response(stream).arrayBuffer();
                return new Uint8Array(out);
            } catch (err) {
                console.warn('[RDCompress] DecompressionStream zstd failed:', err.message || err);
            }
        }

        const decoder = (typeof window !== 'undefined' && window._zstdDecoder)
            || (typeof globalThis !== 'undefined' && globalThis._zstdDecoder);
        if (decoder && typeof decoder.decode === 'function') {
            try {
                const max = Math.min(Math.max(bytes.length * 30, 1024 * 1024), 64 * 1024 * 1024);
                return decoder.decode(bytes, max);
            } catch (err) {
                console.warn('[RDCompress] zstddec fallback failed:', err.message || err);
            }
        }

        return bytes;
    }

    /**
     * Compress bytes with zstd when beneficial (RustDesk clipboard/file parity).
     * @param {Uint8Array} bytes
     * @returns {Promise<{ content: Uint8Array, compress: boolean }>}
     */
    static async compressZstd(bytes) {
        const raw = RDCompress.normalizeBytes(bytes);
        if (!raw.length) {
            return { content: raw, compress: false };
        }
        if (typeof CompressionStream !== 'function' || raw.length <= 128) {
            return { content: raw, compress: false };
        }
        try {
            const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('zstd'));
            const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
            if (compressed.length < raw.length) {
                return { content: compressed, compress: true };
            }
        } catch (_) {
            // fall back to raw payload
        }
        return { content: raw, compress: false };
    }
}
