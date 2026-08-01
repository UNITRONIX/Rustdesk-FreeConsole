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
        const payload = keyService.buildRustDeskConfigPayload('https://desk.example.com:8443/path', {
            publicKey: '',
        });
        expect(payload.host).toBe('desk.example.com');
        expect(payload.relay).toBe('desk.example.com');
    });

    it('buildRustDeskConfigPayload accepts split endpoints object', () => {
        const payload = keyService.buildRustDeskConfigPayload({
            host: 'remote.example.com',
            relay: 'relay.example.com',
            api: 'https://api.example.com',
        }, { publicKey: '' });
        expect(payload.host).toBe('remote.example.com');
        expect(payload.relay).toBe('relay.example.com');
        expect(payload.api).toBe('https://api.example.com');
    });
});

describe('keyService public key validation (#340)', () => {
    // 32 zero bytes → canonical base64 (44 chars with padding)
    const validKey = Buffer.alloc(32, 0).toString('base64');

    afterEach(() => {
        keyService._resetGoKeyCacheForTests();
        jest.restoreAllMocks();
    });

    it('isValidRustDeskPublicKey accepts canonical 32-byte base64', () => {
        expect(keyService.isValidRustDeskPublicKey(validKey)).toBe(true);
    });

    it('isValidRustDeskPublicKey rejects placeholders and junk', () => {
        expect(keyService.isValidRustDeskPublicKey('')).toBe(false);
        expect(keyService.isValidRustDeskPublicKey('v1.4.9_public_key_placeholder...')).toBe(false);
        expect(keyService.isValidRustDeskPublicKey('YOUR_PUBLIC_KEY')).toBe(false);
        expect(keyService.isValidRustDeskPublicKey('__PUB_KEY_PATH__')).toBe(false);
        expect(keyService.isValidRustDeskPublicKey('not-base64!!!')).toBe(false);
        expect(keyService.isValidRustDeskPublicKey(Buffer.alloc(16).toString('base64'))).toBe(false);
    });

    it('getClientConfig embeds valid public key in deploy string', async () => {
        const payload = keyService.buildRustDeskConfigPayload('desk.example.com', { publicKey: validKey });
        const deploy = keyService.encodeRustDeskCliConfigString(payload);
        const json = Buffer.from(deploy.split('').reverse().join(''), 'base64').toString('utf8');
        const decoded = JSON.parse(json);
        expect(decoded.key).toBe(validKey);
        expect(decoded.host).toBe('desk.example.com');
        expect(payload.key).toBe(validKey);
    });

    it('buildRustDeskConfigPayload drops invalid publicKey override', () => {
        const payload = keyService.buildRustDeskConfigPayload('desk.example.com', {
            publicKey: 'v1.4.9_public_key_placeholder...',
        });
        expect(payload.key).toBe('');
    });

    it('getClientConfig with invalid file key and Go fallback fills deploy string', async () => {
        jest.spyOn(keyService, 'getPublicKey').mockReturnValue(null);
        const betterdeskApi = require('../services/betterdeskApi');
        jest.spyOn(betterdeskApi.apiClient, 'get').mockResolvedValue({ data: { key: validKey } });

        const config = await keyService.getClientConfig({
            host: '203.0.113.10',
            relay: '203.0.113.10',
            api: 'http://203.0.113.10:21114',
        });

        expect(config.has_public_key).toBe(true);
        expect(config.public_key).toBe(validKey);
        expect(config.deploy_config_string).toBeTruthy();

        const json = Buffer.from(
            config.deploy_config_string.split('').reverse().join(''),
            'base64'
        ).toString('utf8');
        expect(JSON.parse(json).key).toBe(validKey);
    });

    it('getClientConfig leaves deploy string empty when no valid key exists', async () => {
        jest.spyOn(keyService, 'getPublicKey').mockReturnValue(null);
        const betterdeskApi = require('../services/betterdeskApi');
        jest.spyOn(betterdeskApi.apiClient, 'get').mockResolvedValue({
            data: { key: 'v1.4.9_public_key_placeholder...' },
        });

        const config = await keyService.getClientConfig('desk.example.com');
        expect(config.has_public_key).toBe(false);
        expect(config.public_key).toBe('');
        expect(config.deploy_config_string).toBe('');
    });
});
