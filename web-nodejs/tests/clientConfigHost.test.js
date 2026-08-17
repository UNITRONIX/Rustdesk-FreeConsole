'use strict';

const clientConfigHost = require('../services/clientConfigHost');

describe('clientConfigHost', () => {
    const originalPanelHost = process.env.PANEL_PUBLIC_HOST;
    const originalPublicServerId = process.env.PUBLIC_SERVER_ID;
    const originalPublicRelay = process.env.PUBLIC_RELAY_SERVER;
    const originalPublicApi = process.env.PUBLIC_API_URL;

    afterEach(() => {
        if (originalPanelHost === undefined) delete process.env.PANEL_PUBLIC_HOST;
        else process.env.PANEL_PUBLIC_HOST = originalPanelHost;
        if (originalPublicServerId === undefined) delete process.env.PUBLIC_SERVER_ID;
        else process.env.PUBLIC_SERVER_ID = originalPublicServerId;
        if (originalPublicRelay === undefined) delete process.env.PUBLIC_RELAY_SERVER;
        else process.env.PUBLIC_RELAY_SERVER = originalPublicRelay;
        if (originalPublicApi === undefined) delete process.env.PUBLIC_API_URL;
        else process.env.PUBLIC_API_URL = originalPublicApi;
    });

    it('resolveClientFacingHost prefers query host override when PUBLIC_SERVER_ID unset', () => {
        process.env.PANEL_PUBLIC_HOST = 'panel.internal';
        const host = clientConfigHost.resolveClientFacingHost(
            { headers: { host: 'localhost:5000' } },
            '203.0.113.10'
        );
        expect(host).toBe('203.0.113.10');
    });

    it('resolveClientFacingHost uses PANEL_PUBLIC_HOST before request host', () => {
        process.env.PANEL_PUBLIC_HOST = 'desk.example.com';
        const host = clientConfigHost.resolveClientFacingHost(
            { headers: { host: 'localhost:5000' } },
            ''
        );
        expect(host).toBe('desk.example.com');
    });

    it('resolveRustDeskEndpoints uses split PUBLIC_* env values', () => {
        process.env.PUBLIC_SERVER_ID = 'remote.example.com';
        process.env.PUBLIC_RELAY_SERVER = 'relay.example.com';
        process.env.PUBLIC_API_URL = 'https://api.example.com';

        const endpoints = clientConfigHost.resolveRustDeskEndpoints(
            { headers: { host: 'console.example.com' } },
            ''
        );

        expect(endpoints.host).toBe('remote.example.com');
        expect(endpoints.relay).toBe('relay.example.com');
        expect(endpoints.api).toBe('https://api.example.com');
        expect(endpoints.env_override_active).toBe(true);
        expect(endpoints.sources.host).toBe('env');
    });

    it('resolveRustDeskEndpoints ignores query host when PUBLIC_SERVER_ID is set', () => {
        process.env.PUBLIC_SERVER_ID = 'remote.example.com';
        const endpoints = clientConfigHost.resolveRustDeskEndpoints(
            { headers: { host: 'console.example.com' } },
            '203.0.113.10'
        );
        expect(endpoints.host).toBe('remote.example.com');
    });

    it('stripRequestHost removes port from IPv4 host header', () => {
        expect(clientConfigHost.stripRequestHost('192.168.1.5:5000')).toBe('192.168.1.5');
    });

    it('isPhoneUnreachableHost flags loopback and .local (#368)', () => {
        expect(clientConfigHost.isPhoneUnreachableHost('localhost')).toBe(true);
        expect(clientConfigHost.isPhoneUnreachableHost('127.0.0.1')).toBe(true);
        expect(clientConfigHost.isPhoneUnreachableHost('::1')).toBe(true);
        expect(clientConfigHost.isPhoneUnreachableHost('desk.local')).toBe(true);
        expect(clientConfigHost.isPhoneUnreachableHost('203.0.113.10')).toBe(false);
        expect(clientConfigHost.isPhoneUnreachableHost('desk.example.com')).toBe(false);
    });
});
