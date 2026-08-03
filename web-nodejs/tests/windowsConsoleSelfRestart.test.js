'use strict';

const {
    scheduleWindowsConsoleServiceStart,
    ensureWindowsConsoleAppExitRestart,
} = require('../lib/windowsConsoleSelfRestart');

describe('windowsConsoleSelfRestart', () => {
    test('scheduleWindowsConsoleServiceStart is a no-op on non-Windows', () => {
        if (process.platform === 'win32') return;
        const result = scheduleWindowsConsoleServiceStart({
            spawnFn: () => { throw new Error('should not spawn'); },
        });
        expect(result.scheduled).toBe(false);
    });

    test('scheduleWindowsConsoleServiceStart spawns detached cmd on Windows', () => {
        const calls = [];
        const child = { unref: jest.fn() };
        const result = scheduleWindowsConsoleServiceStart({
            platform: 'win32',
            serviceName: 'BetterDeskConsole',
            delaySec: 2,
            spawnFn: (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return child;
            },
        });

        expect(result.scheduled).toBe(true);
        expect(result.service).toBe('BetterDeskConsole');
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe('cmd.exe');
        expect(calls[0].args.join(' ')).toContain('nssm start "BetterDeskConsole"');
        expect(calls[0].args.join(' ')).toContain('timeout /t 2');
        expect(calls[0].opts.detached).toBe(true);
        expect(calls[0].opts.windowsHide).toBe(true);
        expect(child.unref).toHaveBeenCalled();
    });

    test('ensureWindowsConsoleAppExitRestart sets Restart when missing', () => {
        const fileCalls = [];
        const result = ensureWindowsConsoleAppExitRestart({
            execSync: () => 'Exit',
            execFileSync: (...args) => { fileCalls.push(args); },
            serviceName: 'BetterDeskConsole',
        });
        expect(result.changed).toBe(true);
        expect(fileCalls[0][1]).toEqual(['set', 'BetterDeskConsole', 'AppExit', 'Default', 'Restart']);
    });

    test('ensureWindowsConsoleAppExitRestart is idempotent when already Restart', () => {
        const result = ensureWindowsConsoleAppExitRestart({
            execSync: () => 'Restart',
            execFileSync: () => { throw new Error('should not set'); },
            serviceName: 'BetterDeskConsole',
        });
        expect(result.changed).toBe(false);
    });
});
