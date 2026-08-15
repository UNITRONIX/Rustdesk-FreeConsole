'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    validateDeployRequest,
    deployServerBinaryAtomic,
    buildAllowedDeployTargets,
    resolveDeployScriptPath,
} = require('../lib/linuxServerBinaryDeploy');

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('linuxServerBinaryDeploy', () => {
    let tmpRoot;
    let consoleRoot;
    let serverRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-deploy-'));
        consoleRoot = path.join(tmpRoot, 'web-nodejs');
        serverRoot = path.join(tmpRoot, 'betterdesk-server');
        fs.mkdirSync(serverRoot, { recursive: true });
        fs.writeFileSync(path.join(serverRoot, 'go.mod'), 'module example.com/test\n');
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeBinary(filePath, size = 1024 * 1024) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, Buffer.alloc(size, 1));
    }

    test('validateDeployRequest accepts source under server root and allowed target', () => {
        const source = path.join(serverRoot, 'betterdesk-server');
        writeBinary(source);
        const target = '/opt/rustdesk/betterdesk-server';

        const validated = validateDeployRequest(source, target, {
            consoleRoot,
            projectRoot: tmpRoot,
            serverSourceRoot: serverRoot,
        });

        expect(validated.sourceReal).toBe(path.resolve(source));
        expect(validated.targetPath).toBe(path.resolve(target));
    });

    test('validateDeployRequest rejects source outside server root', () => {
        const outside = path.join(tmpRoot, 'evil', 'betterdesk-server');
        writeBinary(outside);
        const target = '/opt/rustdesk/betterdesk-server';

        expect(() => validateDeployRequest(outside, target, {
            consoleRoot,
            projectRoot: tmpRoot,
            serverSourceRoot: serverRoot,
        })).toThrow(/Source must be under/);
    });

    test('validateDeployRequest rejects disallowed target path', () => {
        const source = path.join(serverRoot, 'betterdesk-server');
        writeBinary(source);

        expect(() => validateDeployRequest(source, '/tmp/betterdesk-server', {
            consoleRoot,
            projectRoot: tmpRoot,
            serverSourceRoot: serverRoot,
        })).toThrow(/Target path is not allowed/);
    });

    test('deployServerBinaryAtomic replaces target atomically', () => {
        const targetDir = path.join(tmpRoot, 'bin');
        const target = path.join(targetDir, 'betterdesk-server');
        const source = path.join(serverRoot, 'betterdesk-server');
        writeBinary(source);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(target, Buffer.from('old-binary'));

        const result = deployServerBinaryAtomic(source, target);
        expect(result.success).toBe(true);
        expect(fs.readFileSync(target).length).toBe(1024 * 1024);
    });

    test('buildAllowedDeployTargets includes standard install paths', () => {
        const targets = buildAllowedDeployTargets({ keysPath: '/opt/rustdesk' });
        expect(targets.has('/opt/rustdesk/betterdesk-server')).toBe(true);
        expect(targets.has('/opt/betterdesk/betterdesk-server')).toBe(true);
    });

    test('resolveDeployScriptPath points at panel helper script', () => {
        expect(resolveDeployScriptPath(consoleRoot)).toBe(
            path.join(consoleRoot, 'scripts/linux-deploy-server-binary.js')
        );
    });
});
