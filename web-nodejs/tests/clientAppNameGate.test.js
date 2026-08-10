/**
 * Tests for Windows client app_name allowlist gate.
 */

const {
    rejectWindowsClientAppName,
    ENV_GATE,
    ENV_ALLOW,
    ERROR_MSG
} = require('../lib/clientAppNameGate');

describe('clientAppNameGate', () => {
    const prevGate = process.env[ENV_GATE];
    const prevAllow = process.env[ENV_ALLOW];

    afterEach(() => {
        if (prevGate === undefined) delete process.env[ENV_GATE];
        else process.env[ENV_GATE] = prevGate;
        if (prevAllow === undefined) delete process.env[ENV_ALLOW];
        else process.env[ENV_ALLOW] = prevAllow;
    });

    test('allows mobile and non-Windows; blocks stock Windows', () => {
        process.env[ENV_GATE] = 'true';
        process.env[ENV_ALLOW] = 'DCS-Norway-RD';

        expect(rejectWindowsClientAppName('android', 'RustDesk')).toBe('');
        expect(rejectWindowsClientAppName('ios', '')).toBe('');
        expect(rejectWindowsClientAppName('linux', 'RustDesk')).toBe('');
        expect(rejectWindowsClientAppName('windows', 'DCS-Norway-RD')).toBe('');
        expect(rejectWindowsClientAppName('windows', 'RustDesk')).toBe(ERROR_MSG);
        expect(rejectWindowsClientAppName('windows', '')).toBe(ERROR_MSG);
    });

    test('disabled gate allows stock Windows', () => {
        process.env[ENV_GATE] = 'false';
        expect(rejectWindowsClientAppName('windows', 'RustDesk')).toBe('');
    });
});
