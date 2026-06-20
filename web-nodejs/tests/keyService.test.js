'use strict';

const keyService = require('../services/keyService');

describe('keyService RustDesk config encoding', () => {
    const samplePayload = {
        host: '203.0.113.10',
        relay: '203.0.113.10',
        api: 'http://203.0.113.10:21114',
        key: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=',
    };

    it('encodeRustDeskConfigUri uses standard base64 JSON', () => {
        const uri = keyService.encodeRustDeskConfigUri(samplePayload);
        expect(uri.startsWith('rustdesk://config/')).toBe(true);
        const b64 = uri.slice('rustdesk://config/'.length);
        const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        expect(decoded).toEqual(samplePayload);
    });

    it('encodeRustDeskCliConfigString reverses base64 without padding', () => {
        const json = JSON.stringify(samplePayload);
        let b64 = Buffer.from(json).toString('base64').replace(/=+$/, '');
        const expected = b64.split('').reverse().join('');

        expect(keyService.encodeRustDeskCliConfigString(samplePayload)).toBe(expected);
    });

    it('buildRustDeskConfigPayload normalizes host input', () => {
        const payload = keyService.buildRustDeskConfigPayload('https://desk.example.com:8443/path');
        expect(payload.host).toBe('desk.example.com');
        expect(payload.relay).toBe('desk.example.com');
    });
});
