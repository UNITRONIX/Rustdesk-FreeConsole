'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    TASK_NAME,
    SERVICE_NAME,
    controlDir,
    isWatchLoopAlive,
    readHeartbeat,
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

    test('exports stable service/task names', () => {
        expect(TASK_NAME).toBe('BetterDeskServiceControl');
        expect(SERVICE_NAME).toBe('BetterDeskServiceControl');
    });

    test('isWatchLoopAlive requires fresh heartbeat', () => {
        expect(isWatchLoopAlive(consoleRoot)).toBe(false);
        fs.writeFileSync(
            path.join(watchDir, 'heartbeat.json'),
            JSON.stringify({ ok: true, at: new Date().toISOString(), mode: 'watch-loop' })
        );
        expect(isWatchLoopAlive(consoleRoot)).toBe(true);
        const hb = readHeartbeat(consoleRoot);
        expect(hb.fresh).toBe(true);
        expect(hb.mode).toBe('watch-loop');
    });

    test('runWindowsPrivilegedServiceJob uses watch-loop without schtasks when heartbeat fresh', () => {
        fs.writeFileSync(
            path.join(watchDir, 'heartbeat.json'),
            JSON.stringify({ ok: true, at: new Date().toISOString(), mode: 'watch-loop' })
        );
        const calls = [];
        const result = runWindowsPrivilegedServiceJob(
            { action: 'stop', service: 'BetterDeskServer' },
            {
                consoleRoot,
                skipEnsure: true,
                timeoutMs: 200,
                pollMs: 20,
                sleep: () => {
                    // Simulate watcher completing on first poll.
                    const pointer = JSON.parse(
                        fs.readFileSync(path.join(watchDir, 'current-request.json'), 'utf8')
                    );
                    if (!fs.existsSync(pointer.resultPath)) {
                        fs.writeFileSync(
                            pointer.resultPath,
                            JSON.stringify({ success: true, action: 'stop', method: 'force-stop' })
                        );
                    }
                },
                execSync: (cmd) => {
                    calls.push(cmd);
                    throw new Error(`unexpected helper start: ${cmd}`);
                },
            }
        );
        expect(result.success).toBe(true);
        expect(result.method).toBe('force-stop');
        expect(calls.length).toBe(0);
    });

    test('runWindowsPrivilegedServiceJob falls back to schtasks when no heartbeat', () => {
        try { fs.unlinkSync(path.join(watchDir, 'heartbeat.json')); } catch (_e) { /* ok */ }
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
                    if (String(cmd).includes('sc query')) {
                        throw new Error('service missing');
                    }
                    if (String(cmd).includes('schtasks /Query')) {
                        return 'TaskName: BetterDeskServiceControl';
                    }
                    if (String(cmd).includes('schtasks /Run')) {
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
        expect(calls.some((c) => String(c).includes('schtasks /Run'))).toBe(true);
    });
});
