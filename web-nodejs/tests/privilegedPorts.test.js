'use strict';

const {
    isPrivilegedPort,
    resolvePortForCurrentUser,
    parseEnvPortSettings,
    resolvePanelHealthPort,
    consoleEnvUsesPrivilegedPorts,
    ensureBindCapabilityInServiceUnit,
    serviceUnitHasBindCapability,
} = require('../lib/privilegedPorts');

describe('privilegedPorts', () => {
    test('isPrivilegedPort detects ports below 1024', () => {
        expect(isPrivilegedPort(443)).toBe(true);
        expect(isPrivilegedPort(80)).toBe(true);
        expect(isPrivilegedPort(1024)).toBe(false);
        expect(isPrivilegedPort(5443)).toBe(false);
    });

    test('parseEnvPortSettings reads HTTPS settings from env content', () => {
        const settings = parseEnvPortSettings([
            'HTTPS_ENABLED=true',
            'HTTPS_PORT=443',
            'PORT=80',
            'HTTP_REDIRECT_HTTPS=false',
        ].join('\n'));
        expect(settings).toEqual({
            port: 80,
            httpsPort: 443,
            httpsEnabled: true,
            httpRedirect: false,
        });
    });

    test('resolvePanelHealthPort uses HTTPS_PORT when HTTPS enabled (not PORT)', () => {
        const settings = parseEnvPortSettings([
            'HTTPS_ENABLED=true',
            'HTTPS_PORT=5443',
            'PORT=5000',
        ].join('\n'));
        expect(resolvePanelHealthPort(settings)).toBe(5443);
    });

    test('resolvePanelHealthPort uses PORT when HTTP mode', () => {
        const settings = parseEnvPortSettings([
            'HTTPS_ENABLED=false',
            'PORT=5000',
            'HTTPS_PORT=5443',
        ].join('\n'));
        expect(resolvePanelHealthPort(settings)).toBe(5000);
    });

    test('consoleEnvUsesPrivilegedPorts detects HTTPS on 443', () => {
        expect(consoleEnvUsesPrivilegedPorts({
            httpsEnabled: true,
            httpsPort: 443,
            port: 5000,
            httpRedirect: true,
        })).toBe(true);
        expect(consoleEnvUsesPrivilegedPorts({
            httpsEnabled: true,
            httpsPort: 5443,
            port: 5000,
            httpRedirect: true,
        })).toBe(false);
    });

    test('ensureBindCapabilityInServiceUnit is idempotent', () => {
        const base = [
            '[Service]',
            'User=betterdesk',
            'ExecStart=/usr/bin/node server.js',
        ].join('\n');
        const first = ensureBindCapabilityInServiceUnit(base);
        expect(first.changed).toBe(true);
        expect(serviceUnitHasBindCapability(first.content)).toBe(true);
        expect(first.content).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');

        const second = ensureBindCapabilityInServiceUnit(first.content);
        expect(second.changed).toBe(false);
    });

    test('resolvePortForCurrentUser falls back for privileged ports when not root', () => {
        const originalGetuid = process.getuid;
        process.getuid = () => 1000;
        try {
            expect(resolvePortForCurrentUser(443, 5443, 'HTTPS')).toBe(5443);
            expect(resolvePortForCurrentUser(5443, 5000, 'HTTPS')).toBe(5443);
        } finally {
            process.getuid = originalGetuid;
        }
    });
});
