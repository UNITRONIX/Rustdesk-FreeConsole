'use strict';

const clientConfigHost = require('../services/clientConfigHost');

describe('clientConfigHost', () => {
    const originalPanelHost = process.env.PANEL_PUBLIC_HOST;

    afterEach(() => {
        if (originalPanelHost === undefined) {
            delete process.env.PANEL_PUBLIC_HOST;
        } else {
            process.env.PANEL_PUBLIC_HOST = originalPanelHost;
        }
    });

    it('resolveClientFacingHost prefers query host override', () => {
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

    it('stripRequestHost removes port from IPv4 host header', () => {
        expect(clientConfigHost.stripRequestHost('192.168.1.5:5000')).toBe('192.168.1.5');
    });
});
