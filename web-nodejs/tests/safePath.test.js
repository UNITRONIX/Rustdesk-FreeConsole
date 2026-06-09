'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    isPathInsideRoot,
    resolveChildPath,
    resolvePathWithinRoot,
    resolvePathWithinAnyRoot,
    resolveLangFilePath,
    resolvePathUnderRoot,
} = require('../lib/safePath');

describe('safePath', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-safe-path-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('isPathInsideRoot accepts descendants', () => {
        const child = path.join(tmpRoot, 'a', 'b.txt');
        expect(isPathInsideRoot(child, tmpRoot)).toBe(true);
    });

    test('isPathInsideRoot rejects parent escape', () => {
        const outside = path.join(tmpRoot, '..', 'etc', 'passwd');
        expect(isPathInsideRoot(outside, tmpRoot)).toBe(false);
    });

    test('resolveChildPath blocks traversal in segment', () => {
        expect(() => resolveChildPath(tmpRoot, '../etc/passwd')).toThrow(/segment/i);
        expect(() => resolveChildPath(tmpRoot, 'foo/bar')).toThrow(/segment/i);
    });

    test('resolveChildPath returns path under root', () => {
        const p = resolveChildPath(tmpRoot, 'backup-1');
        expect(p).toBe(path.resolve(tmpRoot, 'backup-1'));
    });

    test('resolvePathWithinRoot follows realpath for existing files', () => {
        const sub = path.join(tmpRoot, 'sub');
        fs.mkdirSync(sub);
        const file = path.join(sub, 'f.txt');
        fs.writeFileSync(file, 'ok');
        const resolved = resolvePathWithinRoot(file, tmpRoot);
        expect(resolved).toBe(fs.realpathSync.native(file));
    });

    test('resolvePathWithinAnyRoot allows configured roots', () => {
        const p = resolvePathWithinAnyRoot(path.join(tmpRoot, 'x'), [tmpRoot, '/var/log']);
        expect(p).toBe(path.resolve(tmpRoot, 'x'));
    });

    test('resolveLangFilePath confines to lang dir', () => {
        const langDir = path.join(tmpRoot, 'lang');
        fs.mkdirSync(langDir);
        const p = resolveLangFilePath(langDir, 'en');
        expect(p).toBe(path.join(langDir, 'en.json'));
        expect(() => resolveLangFilePath(langDir, '../secrets')).toThrow();
    });

    test('resolvePathUnderRoot follows nested relative paths', () => {
        const sub = path.join(tmpRoot, 'a', 'b');
        fs.mkdirSync(sub, { recursive: true });
        const p = resolvePathUnderRoot(tmpRoot, 'a/b/file.txt');
        expect(p).toBe(path.join(sub, 'file.txt'));
    });

    test('resolvePathUnderRoot blocks traversal', () => {
        expect(() => resolvePathUnderRoot(tmpRoot, '../etc/passwd')).toThrow();
        expect(() => resolvePathUnderRoot(tmpRoot, 'a/../../etc/passwd')).toThrow();
    });
});
