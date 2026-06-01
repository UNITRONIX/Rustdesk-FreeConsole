/**
 * BetterDesk Console - Backup Archive Helper
 *
 * Zero-dependency tar (ustar) writer/reader plus gzip via the built-in zlib
 * module. Used by backupService.js to bundle a full disaster-recovery backup
 * (database, keys, .env, branding uploads, manifest) into a single
 * `.tar.gz` archive that can be extracted with the standard `tar` CLI on any
 * machine.
 *
 * The implementation is intentionally minimal but spec-compliant for the
 * file types we emit (regular files, type '0'). Directory entries are implied
 * by the file paths.
 */

'use strict';

const zlib = require('zlib');

const BLOCK_SIZE = 512;

/**
 * Write a fixed-width, null-terminated octal field into a header buffer.
 * @param {Buffer} buf
 * @param {number} value
 * @param {number} offset
 * @param {number} length total field width (including trailing NUL)
 */
function writeOctal(buf, value, offset, length) {
    // length-1 octal digits, zero-padded, followed by a single NUL.
    const str = value.toString(8).padStart(length - 1, '0');
    buf.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
    buf.write('\0', offset + length - 1, 1, 'ascii');
}

/**
 * Build a single ustar header block for a regular file.
 * @param {string} name archive-relative path (forward slashes)
 * @param {number} size payload size in bytes
 * @param {number} mode unix mode bits
 * @param {number} mtime seconds since epoch
 * @returns {Buffer} 512-byte header
 */
function buildHeader(name, size, mode, mtime) {
    const header = Buffer.alloc(BLOCK_SIZE, 0);

    let filename = name;
    let prefix = '';
    // ustar splits long names into prefix (155) + name (100).
    if (Buffer.byteLength(filename, 'utf8') > 100) {
        const idx = filename.lastIndexOf('/', 155);
        if (idx > 0) {
            prefix = filename.slice(0, idx);
            filename = filename.slice(idx + 1);
        }
    }
    if (Buffer.byteLength(filename, 'utf8') > 100) {
        throw new Error(`Archive entry name too long: ${name}`);
    }

    header.write(filename, 0, 100, 'utf8');
    writeOctal(header, mode & 0o7777, 100, 8);
    writeOctal(header, 0, 108, 8);            // uid
    writeOctal(header, 0, 116, 8);            // gid
    writeOctal(header, size, 124, 12);        // size
    writeOctal(header, Math.floor(mtime), 136, 12); // mtime
    header.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
    header.write('0', 156, 1, 'ascii');        // typeflag: regular file
    header.write('ustar\0', 257, 6, 'ascii');  // magic
    header.write('00', 263, 2, 'ascii');       // version
    if (prefix) header.write(prefix, 345, 155, 'utf8');

    // Compute checksum (sum of all bytes, treating chksum field as spaces).
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
    const chksum = sum.toString(8).padStart(6, '0').slice(-6);
    header.write(chksum, 148, 6, 'ascii');
    header.write('\0', 154, 1, 'ascii');
    header.write(' ', 155, 1, 'ascii');

    return header;
}

/**
 * Pad a payload to the next 512-byte boundary.
 */
function padToBlock(size) {
    const rem = size % BLOCK_SIZE;
    return rem === 0 ? 0 : BLOCK_SIZE - rem;
}

/**
 * Create a gzipped tar archive from a list of entries.
 * @param {Array<{name: string, data: Buffer|string, mode?: number, mtime?: number}>} entries
 * @returns {Buffer} gzipped tar archive
 */
function createTarGz(entries) {
    const chunks = [];
    const now = Math.floor(Date.now() / 1000);

    for (const entry of entries) {
        if (!entry || !entry.name) continue;
        const data = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data == null ? '' : String(entry.data), 'utf8');
        const name = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
        const header = buildHeader(name, data.length, entry.mode || 0o644, entry.mtime || now);
        chunks.push(header, data);
        const pad = padToBlock(data.length);
        if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }

    // Two trailing zero blocks mark end of archive.
    chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

    const tar = Buffer.concat(chunks);
    return zlib.gzipSync(tar, { level: 9 });
}

/**
 * Parse an octal numeric field from a tar header.
 */
function parseOctal(buf, offset, length) {
    let str = buf.toString('ascii', offset, offset + length);
    // Trim NULs / spaces.
    str = str.replace(/[\0 ]/g, '');
    if (str === '') return 0;
    const n = parseInt(str, 8);
    return Number.isNaN(n) ? 0 : n;
}

/**
 * Extract a gzipped tar archive into a Map of name -> Buffer.
 * @param {Buffer} buffer gzipped tar archive
 * @returns {Map<string, Buffer>}
 */
function extractTarGz(buffer) {
    const tar = zlib.gunzipSync(buffer);
    const files = new Map();
    let offset = 0;

    while (offset + BLOCK_SIZE <= tar.length) {
        const header = tar.slice(offset, offset + BLOCK_SIZE);
        // End-of-archive: an all-zero block.
        if (header.every((b) => b === 0)) break;

        let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
        if (prefix) name = `${prefix}/${name}`;

        const size = parseOctal(header, 124, 12);
        const typeflag = header.toString('ascii', 156, 157);
        offset += BLOCK_SIZE;

        const data = tar.slice(offset, offset + size);
        offset += size + padToBlock(size);

        // Only collect regular files ('0' or NUL typeflag).
        if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
            files.set(name, Buffer.from(data));
        }
    }

    return files;
}

module.exports = {
    createTarGz,
    extractTarGz,
};
