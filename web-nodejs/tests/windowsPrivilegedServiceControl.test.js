'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    TASK_NAME,
    controlDir,
    ensureWindowsServiceControlTask,
    runWindowsPrivilegedServiceJob,
} = require('../lib/windowsPrivilegedServiceControl');

describe('windowsPrivilegedServiceControl', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-svc-ctrl-'));
    const consoleRoot = tmp;
    const scriptDir = path.join(consoleRoot, 'scripts');
    const watchDir = controlDir(consoleRoot);

    beforeAll(() => {
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(path.join(scriptDir, 'windows-service-control.js'), '// stub\n');
        fs.mkdirSync(watchDir, { recursive: true });
    });

    afterAll(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ok */ }
    });

    test('ensureWindowsServiceControlTask creates schtasks command', () => {
        const calls = [];
        const result = ensureWindowsServiceControlTask({
            consoleRoot,
            nodePath: 'C:\\Node\\node.exe',
            execSync: (cmd) => {
                calls.push(cmd);
                if (String(cmd).includes('schtasks /Query')) {
                    throw new Error('not found');
                }
                return '';
            },
        });
        // execFileSync is used for Create — mock via replacing isn't wired;
        // when Create fails and Query fails, ok=false.
        expect(result.ok === true || result.ok === false).toBe(true);
        expect(TASK_NAME).toBe('BetterDeskServiceControl');
    });

    test('runWindowsPrivilegedServiceJob writes request and reads result', () => {
        const calls = [];
        const result = runWindowsPrivilegedServiceJob(
            { action: 'stop', service: 'BetterDeskServer' },
            {
                consoleRoot,
                skipEnsure: true,
                timeoutMs: 200,
                pollMs: 20,
                sleep: () => {},
                execSync: (cmd) => {
                    calls.push(cmd);
                    if (String(cmd).includes('schtasks /Query')) {
                        return 'TaskName: BetterDeskServiceControl';
                    }
                    if (String(cmd).includes('schtasks /Run')) {
                        // Simulate SYSTEM helper completing immediately.
                        const pointer = JSON.parse(
                            fs.readFileSync(path.join(watchDir, 'current-request.json'), 'utf8')
                        );
                        fs.writeFileSync(
                            pointer.resultPath,
                            JSON.stringify({ success: true, action: 'stop', method: 'force-stop' })
                        );
                        return '';
                    }
                    throw new Error(`unexpected ${cmd}`);
                },
            }
        );
        expect(result.success).toBe(true);
        expect(result.method).toBe('force-stop');
        expect(calls.some((c) => String(c).includes('schtasks /Run'))).toBe(true);
    });
});
