'use strict';

const {
    isAllowedSystemdUnitPath,
    normalizeUnitPath,
    resolveSystemdUnitScriptPath,
    privilegedSystemdUnitHint,
} = require('../lib/linuxSystemdUnitPrivileged');

describe('linuxSystemdUnitPrivileged', () => {
    test('allows BetterDesk systemd unit paths only', () => {
        expect(isAllowedSystemdUnitPath('/etc/systemd/system/betterdesk-server.service')).toBe(true);
        expect(isAllowedSystemdUnitPath('/etc/systemd/system/betterdesk-console.service')).toBe(true);
        expect(isAllowedSystemdUnitPath('/etc/systemd/system/sshd.service')).toBe(false);
        expect(isAllowedSystemdUnitPath('/tmp/betterdesk-server.service')).toBe(false);
    });

    test('normalizeUnitPath resolves absolute paths', () => {
        expect(normalizeUnitPath('/etc/systemd/system/betterdesk-server.service'))
            .toBe('/etc/systemd/system/betterdesk-server.service');
        expect(normalizeUnitPath('relative/path')).toBeNull();
    });

    test('resolveSystemdUnitScriptPath points at helper script', () => {
        const script = resolveSystemdUnitScriptPath('/opt/betterdesk/web-nodejs');
        expect(script).toContain('linux-write-systemd-unit.js');
    });

    test('privilegedSystemdUnitHint mentions linux-ensure-console-user.js', () => {
        expect(privilegedSystemdUnitHint()).toContain('linux-ensure-console-user.js');
    });
});
