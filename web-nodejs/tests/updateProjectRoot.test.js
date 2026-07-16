'use strict';

const path = require('path');
const {
    isFilesystemRoot,
    resolveProjectRoot,
    ensureParentDirForFile,
    isUpdatePermissionError,
} = require('../lib/updateProjectRoot');

describe('updateProjectRoot', () => {
    test('detects filesystem / drive roots', () => {
        expect(isFilesystemRoot(path.parse(process.cwd()).root)).toBe(true);
        expect(isFilesystemRoot(path.join(process.cwd(), 'subdir'))).toBe(false);
    });

    test('uses console dir when parent would be a filesystem root (#272)', () => {
        // Windows default: C:\BetterDeskConsole → parent C:\
        // Linux analogue: /BetterDeskConsole → parent /
        const consoleDir = path.join(path.parse(process.cwd()).root, 'BetterDeskConsole');
        const root = resolveProjectRoot(consoleDir, { existsSync: () => false });
        expect(path.resolve(root)).toBe(path.resolve(consoleDir));
        expect(isFilesystemRoot(root)).toBe(false);
    });

    test('uses flat console when betterdesk-server lives beside services', () => {
        const consoleDir = '/opt/BetterDeskConsole';
        const exists = (p) => p === path.join(path.resolve(consoleDir), 'betterdesk-server', 'go.mod');
        expect(resolveProjectRoot(consoleDir, { existsSync: exists })).toBe(path.resolve(consoleDir));
    });

    test('uses repo parent when betterdesk-server/go.mod is present', () => {
        const consoleDir = '/home/dev/BetterDesk/web-nodejs';
        const parent = path.resolve(consoleDir, '..');
        const exists = (p) => p === path.join(parent, 'betterdesk-server', 'go.mod');
        expect(resolveProjectRoot(consoleDir, { existsSync: exists })).toBe(parent);
    });

    test('uses repo parent when betterdesk.ps1 marker exists one level up', () => {
        const consoleDir = '/opt/BetterDeskConsole';
        const parent = path.resolve(consoleDir, '..');
        const exists = (p) => p === path.join(parent, 'betterdesk.ps1');
        expect(resolveProjectRoot(consoleDir, { existsSync: exists })).toBe(parent);
    });

    test('falls back to console dir for split installs without parent markers', () => {
        const consoleDir = '/opt/BetterDeskConsole';
        expect(resolveProjectRoot(consoleDir, { existsSync: () => false })).toBe(path.resolve(consoleDir));
    });

    test('ensureParentDirForFile skips mkdir on drive/filesystem root', () => {
        const calls = [];
        const rootFile = path.join(path.parse(process.cwd()).root, 'Dockerfile');
        ensureParentDirForFile(rootFile, {
            mkdirSync: (p) => { calls.push(p); },
        });
        expect(calls).toEqual([]);
    });

    test('ensureParentDirForFile creates nested parents', () => {
        const calls = [];
        const file = path.join(process.cwd(), 'tmp-proj', 'scripts', 'Dockerfile');
        ensureParentDirForFile(file, {
            mkdirSync: (p, o) => { calls.push({ p, o }); },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].o).toEqual({ recursive: true });
        expect(calls[0].p).toBe(path.dirname(path.resolve(file)));
    });

    test('isUpdatePermissionError matches EPERM and Access is denied', () => {
        expect(isUpdatePermissionError({ code: 'EPERM', message: "EPERM: operation not permitted, mkdir 'C:\\'" })).toBe(true);
        expect(isUpdatePermissionError({ code: 'EACCES', message: 'permission denied' })).toBe(true);
        expect(isUpdatePermissionError({ message: 'OpenService(): Access is denied.' })).toBe(true);
        expect(isUpdatePermissionError({ message: 'disk full' })).toBe(false);
    });
});
