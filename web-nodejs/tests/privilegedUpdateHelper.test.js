'use strict';

const {
    ALLOWED_SERVICES,
    PRIVILEGED_UPDATE_HELPER_PATH,
    invokePrivilegedUpdate,
    restartService,
} = require('../lib/privilegedUpdateHelper');

describe('privileged update broker client', () => {
    test('uses a fixed root-owned helper and a narrow service allowlist', () => {
        expect(PRIVILEGED_UPDATE_HELPER_PATH)
            .toBe('/usr/local/libexec/betterdesk/betterdesk-privileged-update.js');
        expect([...ALLOWED_SERVICES]).toEqual(
            expect.arrayContaining(['betterdesk-console', 'betterdesk-server']),
        );
        expect(ALLOWED_SERVICES.has('sshd')).toBe(false);
    });

    test('rejects malformed requests before invoking a privileged process', () => {
        expect(() => invokePrivilegedUpdate(null)).toThrow(/Invalid privileged update request/);
        expect(() => restartService('sshd')).toThrow(/Service is not allowlisted/);
    });
});
