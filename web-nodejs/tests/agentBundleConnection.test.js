'use strict';

const conn = require('../services/agentBundleConnection');

describe('agentBundleConnection', () => {
    it('normalizeServerHost strips scheme and port', () => {
        const r = conn.normalizeServerHost('https://desk.example.com:8443/path');
        expect(r.valid).toBe(true);
        expect(r.host).toBe('desk.example.com');
    });

    it('buildServerUrls omits default https port', () => {
        const urls = conn.buildServerUrls('desk.example.com', true, '443');
        expect(urls.address).toBe('https://desk.example.com');
        expect(urls.api_url).toBe('https://desk.example.com/api');
    });

    it('buildServerUrls bakes Go API and CDAP only (no web console)', () => {
        const urls = conn.buildServerUrls('desk.example.com', false, '21114');
        expect(urls.address).toBe('http://desk.example.com:21114');
        expect(urls.api_url).toBe('http://desk.example.com:21114/api');
        expect(urls.cdap_url).toBe('ws://desk.example.com:21122/cdap');
        expect(urls.cdap_port).toBe(21122);
        expect(urls.console_url).toBeUndefined();
        expect(urls.console_port).toBeUndefined();
    });

    it('connectionFingerprint compares host and TLS only', () => {
        const a = { server_host: 'a.example.com', use_https: true };
        const b = { server: { address: 'https://a.example.com:21114' }, use_https: true };
        expect(conn.connectionFingerprint(a)).toBe(conn.connectionFingerprint(b));
    });
});
