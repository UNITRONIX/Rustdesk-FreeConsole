'use strict';

const {
    restartWindowsNssmService,
    stopWindowsNssmService,
    startWindowsNssmService,
    isStatusPaused,
    isStatusRunning,
    isStatusStopped,
} = require('../lib/windowsNssmRestart');

function makeExecSync(getStatus, setStatus) {
    return (cmd) => {
        if (cmd.includes('nssm status')) {
            return getStatus();
        }
        if (cmd.includes('nssm continue')) {
            setStatus('SERVICE_RUNNING');
            return '';
        }
        if (cmd.includes('nssm stop')) {
            setStatus('SERVICE_STOPPED');
            return '';
        }
        if (cmd.includes('nssm start')) {
            setStatus('SERVICE_RUNNING');
            return '';
        }
        if (cmd.includes('nssm restart')) {
            setStatus('SERVICE_RUNNING');
            return '';
        }
        throw new Error(`unexpected: ${cmd}`);
    };
}

describe('windowsNssmRestart', () => {
    test('status helpers match NSSM tokens', () => {
        expect(isStatusRunning('SERVICE_RUNNING')).toBe(true);
        expect(isStatusStopped('SERVICE_STOPPED')).toBe(true);
        expect(isStatusPaused('SERVICE_PAUSED')).toBe(true);
        expect(isStatusRunning('SERVICE_PAUSED')).toBe(false);
    });

    test('stopWindowsNssmService reaches SERVICE_STOPPED', () => {
        let status = 'SERVICE_RUNNING';
        const calls = [];
        const execSync = (cmd) => {
            calls.push(cmd);
            return makeExecSync(() => status, (s) => { status = s; })(cmd);
        };

        const result = stopWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe('stop');
        expect(status).toBe('SERVICE_STOPPED');
        expect(calls.some((c) => c.includes('nssm stop'))).toBe(true);
        expect(calls.some((c) => c.includes('nssm restart'))).toBe(false);
    });

    test('startWindowsNssmService reaches SERVICE_RUNNING', () => {
        let status = 'SERVICE_STOPPED';
        const result = startWindowsNssmService('BetterDeskServer', {
            execSync: makeExecSync(() => status, (s) => { status = s; }),
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe('start');
        expect(status).toBe('SERVICE_RUNNING');
    });

    test('startWindowsNssmService no-ops when already running', () => {
        const calls = [];
        let status = 'SERVICE_RUNNING';
        const execSync = (cmd) => {
            calls.push(cmd);
            return makeExecSync(() => status, (s) => { status = s; })(cmd);
        };

        const result = startWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.method).toBe('already-running');
        expect(calls.some((c) => c.includes('nssm start'))).toBe(false);
    });

    test('recovers from SERVICE_PAUSED via continue then stop-start', () => {
        const calls = [];
        let status = 'SERVICE_PAUSED';

        const execSync = (cmd) => {
            calls.push(cmd);
            return makeExecSync(() => status, (s) => { status = s; })(cmd);
        };

        const result = restartWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe('stop-start');
        expect(calls.some((c) => c.includes('nssm continue'))).toBe(true);
        expect(calls.some((c) => c.includes('nssm stop'))).toBe(true);
        expect(calls.some((c) => c.includes('nssm start'))).toBe(true);
        expect(calls.some((c) => c.includes('nssm restart'))).toBe(false);
    });

    test('clears SERVICE_PAUSED returned by nssm start', () => {
        const calls = [];
        let status = 'SERVICE_RUNNING';
        let startAttempts = 0;

        const execSync = (cmd) => {
            calls.push(cmd);
            if (cmd.includes('nssm status')) {
                return status;
            }
            if (cmd.includes('nssm stop')) {
                status = 'SERVICE_STOPPED';
                return '';
            }
            if (cmd.includes('nssm start')) {
                startAttempts += 1;
                if (startAttempts === 1) {
                    status = 'SERVICE_PAUSED';
                    const err = new Error(
                        'Command failed: nssm start "BetterDeskServer"\n'
                        + 'BetterDeskServer: Unexpected status SERVICE_PAUSED in response to START control.'
                    );
                    err.stdout = 'SERVICE_PAUSED';
                    throw err;
                }
                status = 'SERVICE_RUNNING';
                return '';
            }
            if (cmd.includes('nssm continue')) {
                status = 'SERVICE_RUNNING';
                return '';
            }
            throw new Error(`unexpected: ${cmd}`);
        };

        const result = restartWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.success).toBe(true);
        expect(calls.filter((c) => c.includes('nssm continue')).length).toBeGreaterThanOrEqual(1);
    });

    test('stop-start when service is already running', () => {
        const calls = [];
        let status = 'SERVICE_RUNNING';

        const execSync = (cmd) => {
            calls.push(cmd);
            return makeExecSync(() => status, (s) => { status = s; })(cmd);
        };

        const result = restartWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 50,
            startTimeoutMs: 50,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe('stop-start');
        expect(calls.some((c) => c.includes('nssm restart'))).toBe(false);
    });

    test('throws when service never reaches SERVICE_RUNNING', () => {
        let status = 'SERVICE_STOPPED';
        const execSync = (cmd) => {
            if (cmd.includes('nssm status')) return status;
            if (cmd.includes('nssm stop')) {
                status = 'SERVICE_STOPPED';
                return '';
            }
            if (cmd.includes('nssm start') || cmd.includes('nssm continue')) {
                status = 'SERVICE_PAUSED';
                return '';
            }
            return '';
        };

        expect(() => restartWindowsNssmService('BetterDeskServer', {
            execSync,
            sleep: () => {},
            pollMs: 1,
            stopTimeoutMs: 20,
            startTimeoutMs: 20,
        })).toThrow(/did not reach SERVICE_RUNNING/);
    });
});
