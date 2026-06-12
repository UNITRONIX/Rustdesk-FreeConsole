'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readProductVersion } = require('../lib/productVersion');

describe('productVersion', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-version-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('reads semver from repo-root VERSION', () => {
        fs.writeFileSync(path.join(tmpRoot, 'VERSION'), '4.1.2\n');
        expect(readProductVersion({ rootDir: tmpRoot })).toBe('4.1.2');
    });

    test('falls back to package.json when VERSION is missing', () => {
        const consoleDir = path.join(tmpRoot, 'web-nodejs');
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(
            path.join(consoleDir, 'package.json'),
            JSON.stringify({ version: '3.9.8' })
        );
        expect(readProductVersion({ rootDir: tmpRoot, consoleDir })).toBe('3.9.8');
    });

    test('prefers VERSION over package.json', () => {
        const consoleDir = path.join(tmpRoot, 'web-nodejs');
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'VERSION'), '2.0.1\n');
        fs.writeFileSync(
            path.join(consoleDir, 'package.json'),
            JSON.stringify({ version: '9.9.9' })
        );
        expect(readProductVersion({ rootDir: tmpRoot, consoleDir })).toBe('2.0.1');
    });

    test('reads VERSION from console dir when repo root VERSION is missing', () => {
        const consoleDir = path.join(tmpRoot, 'console');
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, 'VERSION'), '3.3.0\n');
        fs.writeFileSync(
            path.join(consoleDir, 'package.json'),
            JSON.stringify({ version: '3.2.0' })
        );
        expect(readProductVersion({ rootDir: tmpRoot, consoleDir })).toBe('3.3.0');
    });

    test('returns fallback when no sources available', () => {
        expect(readProductVersion({ rootDir: tmpRoot, fallback: '0.0.0' })).toBe('0.0.0');
    });
});
