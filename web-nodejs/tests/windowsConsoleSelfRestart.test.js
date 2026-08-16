'use strict';

const path = require('path');
const {
    scheduleWindowsConsoleServiceStart,
    ensureWindowsConsoleAppExitRestart,
    ensureWindowsConsoleServiceEnvFlag,
    spawnDetachedConsoleProcess,
    isWindowsConsoleServiceContext,
    prepareWindowsConsoleRestart,
} = require('../lib/windowsConsoleSelfRestart');

describe('windowsConsoleSelfRestart', () => {
    test('scheduleWindowsConsoleServiceStart is a no-op on non-Windows', () => {
        const result = scheduleWindowsConsoleServiceStart({
            platform: 'linux',
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
        expect(calls[0].cmd).toBe('cmd.exe');
        expect(calls[0].args.join(' ')).toContain('nssm start "BetterDeskConsole"');
        expect(child.unref).toHaveBeenCalled();
    });

    test('isWindowsConsoleServiceContext uses BETTERDESK_SERVICE and TTY', () => {
        expect(isWindowsConsoleServiceContext({
            platform: 'win32',
            env: { BETTERDESK_SERVICE: '1' },
            stdoutIsTTY: true,
            stderrIsTTY: true,
        })).toBe(true);

        expect(isWindowsConsoleServiceContext({
            platform: 'win32',
            env: {},
            stdoutIsTTY: true,
            stderrIsTTY: false,
        })).toBe(false);

        expect(isWindowsConsoleServiceContext({
            platform: 'win32',
            env: {},
            stdoutIsTTY: false,
            stderrIsTTY: false,
        })).toBe(true);
    });

    test('spawnDetachedConsoleProcess starts delayed node via cmd', () => {
        const calls = [];
        const child = { unref: jest.fn(), pid: 4242 };
        const consoleRoot = path.join(__dirname, '..');
        const result = spawnDetachedConsoleProcess({
            platform: 'win32',
            consoleRoot,
            nodePath: 'C:\\Node\\node.exe',
            delaySec: 3,
            env: { BETTERDESK_SERVICE: '1', PORT: '5000' },
            spawnFn: (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return child;
            },
        });

        expect(result.spawned).toBe(true);
        expect(result.delaySec).toBe(3);
        expect(calls[0].cmd).toBe('cmd.exe');
        expect(calls[0].args.join(' ')).toContain('timeout /t 3');
        expect(calls[0].args.join(' ')).toContain('C:\\Node\\node.exe');
        expect(calls[0].args.join(' ')).toContain('server.js');
        expect(calls[0].opts.detached).toBe(true);
        expect(calls[0].opts.env.BETTERDESK_SERVICE).toBeUndefined();
        expect(calls[0].opts.env.PORT).toBe('5000');
    });

    test('prepareWindowsConsoleRestart re-execs interactive sessions', () => {
        const spawnCalls = [];
        const child = { unref: jest.fn(), pid: 7 };
        const result = prepareWindowsConsoleRestart({
            platform: 'win32',
            env: {},
            stdoutIsTTY: true,
            stderrIsTTY: true,
            consoleRoot: path.join(__dirname, '..'),
            spawnFn: (cmd, args, opts) => {
                spawnCalls.push({ cmd, args, opts });
                return child;
            },
        });

        expect(result.mode).toBe('interactive-reexec');
        expect(result.reexec.spawned).toBe(true);
        expect(spawnCalls[0].cmd).toBe('cmd.exe');
        expect(spawnCalls[0].args.join(' ')).toContain('server.js');
    });

    test('prepareWindowsConsoleRestart uses NSSM path for service context', () => {
        const result = prepareWindowsConsoleRestart({
            platform: 'win32',
            env: { BETTERDESK_SERVICE: '1' },
            stdoutIsTTY: false,
            stderrIsTTY: false,
            execSync: (cmd) => {
                if (String(cmd).includes('AppExit')) return 'Restart';
                if (String(cmd).includes('AppEnvironmentExtra')) return 'NODE_ENV=production\nBETTERDESK_SERVICE=1\n';
                return '';
            },
            execFileSync: () => { throw new Error('should not set'); },
            spawnFn: () => ({ unref() {} }),
        });

        expect(result.mode).toBe('service');
        expect(result.scheduled.scheduled).toBe(true);
        expect(result.reexec).toBeNull();
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

    test('ensureWindowsConsoleServiceEnvFlag appends marker', () => {
        const fileCalls = [];
        const result = ensureWindowsConsoleServiceEnvFlag({
            execSync: () => 'NODE_ENV=production\n',
            execFileSync: (...args) => { fileCalls.push(args); },
        });
        expect(result.changed).toBe(true);
        expect(fileCalls[0][1]).toEqual([
            'set',
            'BetterDeskConsole',
            'AppEnvironmentExtra',
            expect.stringContaining('BETTERDESK_SERVICE=1'),
        ]);
    });
});
