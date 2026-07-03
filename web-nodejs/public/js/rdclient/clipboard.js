/**
 * BetterDesk Web Remote Client - inbound clipboard decode/apply
 * Handles RustDesk Clipboard / MultiClipboards (zstd, text/html/image).
 */

/* global RDCompress */

// eslint-disable-next-line no-unused-vars
class RDClipboard {
    static OWNER_FORMAT = 'dyn.com.rustdesk.owner';

    static FORMAT = {
        Text: 0,
        Rtf: 1,
        Html: 2,
        ImageRgba: 21,
        ImagePng: 22,
        ImageSvg: 23,
        Special: 31
    };

    /**
     * @param {number|string} format
     * @returns {number}
     */
    static formatId(format) {
        if (format == null) return RDClipboard.FORMAT.Text;
        if (typeof format === 'number') return format;
        const map = {
            Text: RDClipboard.FORMAT.Text,
            Rtf: RDClipboard.FORMAT.Rtf,
            Html: RDClipboard.FORMAT.Html,
            ImageRgba: RDClipboard.FORMAT.ImageRgba,
            ImagePng: RDClipboard.FORMAT.ImagePng,
            ImageSvg: RDClipboard.FORMAT.ImageSvg,
            Special: RDClipboard.FORMAT.Special
        };
        return map[format] != null ? map[format] : RDClipboard.FORMAT.Text;
    }

    /**
     * @param {Object} clipboard
     * @returns {boolean}
     */
    static shouldSkipEntry(clipboard) {
        if (!clipboard) return true;
        const fmt = RDClipboard.formatId(clipboard.format);
        if (fmt !== RDClipboard.FORMAT.Special) return false;
        const name = clipboard.specialName || clipboard.special_name || '';
        return name === RDClipboard.OWNER_FORMAT;
    }

    /**
     * @param {*} content
     * @returns {Uint8Array|null}
     */
    static normalizeContent(content) {
        if (!content) return null;
        if (content instanceof Uint8Array) return content;
        if (content instanceof ArrayBuffer) return new Uint8Array(content);
        if (content.length != null) return new Uint8Array(content);
        return null;
    }

    /**
     * @param {string} html
     * @returns {string}
     */
    static stripHtml(html) {
        if (!html) return '';
        if (typeof DOMParser === 'undefined') return '';
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return (doc.body && doc.body.textContent) ? doc.body.textContent : '';
        } catch (_) {
            return '';
        }
    }

    /**
     * @param {string} rtf
     * @returns {string}
     */
    static extractRtfPlain(rtf) {
        if (!rtf) return '';
        const plainMatch = rtf.match(/\\plain[\s\S]*?(?=\\par|\\cell|\\row|\\}|$)/i);
        if (plainMatch) {
            return plainMatch[0]
                .replace(/^\\plain\s*/i, '')
                .replace(/\\[a-z]+\d* ?/gi, '')
                .replace(/[{}]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }
        return rtf
            .replace(/\\[a-z]+\d* ?/gi, '')
            .replace(/[{}]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {Uint8Array} rgbaBytes
     * @returns {Promise<Blob|null>}
     */
    static rgbaToPngBlob(width, height, rgbaBytes) {
        const w = Number(width) || 0;
        const h = Number(height) || 0;
        const expected = w * h * 4;
        if (!w || !h || rgbaBytes.length < expected) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            try {
                const canvas = (typeof OffscreenCanvas !== 'undefined')
                    ? new OffscreenCanvas(w, h)
                    : document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                const slice = rgbaBytes.subarray(0, expected);
                const imgData = new ImageData(new Uint8ClampedArray(slice), w, h);
                ctx.putImageData(imgData, 0, 0);

                if (canvas.convertToBlob) {
                    canvas.convertToBlob({ type: 'image/png' }).then(resolve).catch(() => resolve(null));
                    return;
                }
                canvas.toBlob((blob) => resolve(blob), 'image/png');
            } catch (_) {
                resolve(null);
            }
        });
    }

    /**
     * @param {Object} clipboard - protobuf Clipboard
     * @returns {Promise<Object|null>}
     */
    static async decodeEntry(clipboard) {
        if (!clipboard || RDClipboard.shouldSkipEntry(clipboard)) return null;

        let bytes = RDClipboard.normalizeContent(clipboard.content);
        if (!bytes || !bytes.length) return null;

        const needsDecompress = !!clipboard.compress || RDCompress.isZstdMagic(bytes);
        if (needsDecompress) {
            bytes = await RDCompress.decompressZstd(bytes, { force: true });
        }

        const fmt = RDClipboard.formatId(clipboard.format);
        const decoder = new TextDecoder('utf-8', { fatal: false });

        switch (fmt) {
            case RDClipboard.FORMAT.Text:
                return { format: 'text', text: decoder.decode(bytes) };
            case RDClipboard.FORMAT.Html: {
                const html = decoder.decode(bytes);
                return { format: 'html', html, text: RDClipboard.stripHtml(html) };
            }
            case RDClipboard.FORMAT.Rtf: {
                const rtf = decoder.decode(bytes);
                return { format: 'rtf', text: RDClipboard.extractRtfPlain(rtf) };
            }
            case RDClipboard.FORMAT.ImagePng:
                return { format: 'image/png', pngBlob: new Blob([bytes], { type: 'image/png' }) };
            case RDClipboard.FORMAT.ImageRgba: {
                const blob = await RDClipboard.rgbaToPngBlob(clipboard.width, clipboard.height, bytes);
                if (!blob) return null;
                return { format: 'image/png', pngBlob: blob };
            }
            case RDClipboard.FORMAT.ImageSvg: {
                const svg = decoder.decode(bytes);
                return { format: 'image/svg+xml', svgText: svg, text: svg };
            }
            default:
                return null;
        }
    }

    /**
     * @param {Object[]} entries
     * @returns {string}
     */
    static pickBestText(entries) {
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e && e.format === 'text' && e.text) return e.text;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e && e.format === 'html' && e.text) return e.text;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e && e.format === 'rtf' && e.text) return e.text;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e && e.format === 'image/svg+xml' && e.text) return e.text;
        }
        return '';
    }

    /**
     * @param {Object[]} decodedEntries
     * @param {Object} [opts]
     * @param {boolean} [opts.enabled]
     * @returns {Promise<void>}
     */
    static async applyToLocal(decodedEntries, opts) {
        const options = opts || {};
        if (!options.enabled) return;
        if (!navigator.clipboard) return;

        const entries = (decodedEntries || []).filter(Boolean);
        if (!entries.length) return;

        const text = RDClipboard.pickBestText(entries);
        const htmlEntry = entries.find((e) => e.format === 'html' && e.html);
        const pngEntry = entries.find((e) => e.pngBlob);
        const svgEntry = entries.find((e) => e.format === 'image/svg+xml' && e.svgText);

        try {
            if (pngEntry && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngEntry.pngBlob })]);
                return;
            }
            if (svgEntry && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
                const blob = new Blob([svgEntry.svgText], { type: 'image/svg+xml' });
                await navigator.clipboard.write([new ClipboardItem({ 'image/svg+xml': blob })]);
                return;
            }
            if (htmlEntry && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
                const plain = htmlEntry.text || RDClipboard.stripHtml(htmlEntry.html);
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([htmlEntry.html], { type: 'text/html' }),
                    'text/plain': new Blob([plain], { type: 'text/plain' })
                })]);
                return;
            }
            if (text && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            }
        } catch (err) {
            if (text && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(text);
                } catch (_) {
                    // permission denied — ignore
                }
            }
        }
    }

    /**
     * @param {Object[]} clipboards
     * @returns {Promise<Object[]>}
     */
    static async decodeEntries(clipboards) {
        const list = clipboards || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const decoded = await RDClipboard.decodeEntry(list[i]);
            if (decoded) out.push(decoded);
        }
        return out;
    }
}
