'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { upsertEnvKey } = require('../lib/envMerge');

const {
    parseEnvFile,
    validateSettings,
    isEnvOverrideActive,
    normalizeSettings,
} = require('../services/rustDeskPublicEndpointsService');

describe('rustDeskPublicEndpointsService', () => {
    it('validateSettings accepts split-domain values', () => {
        const normalized = validateSettings({
            public_server_id: 'remote.example.com',
            public_relay_server: 'relay.example.com',
            public_api_url: 'https://api.example.com/',
        });
        expect(normalized.public_server_id).toBe('remote.example.com');
        expect(normalized.public_relay_server).toBe('relay.example.com');
        expect(normalized.public_api_url).toBe('https://api.example.com');
    });

    it('validateSettings allows clearing all fields', () => {
        expect(validateSettings({
            public_server_id: '',
            public_relay_server: '',
            public_api_url: '',
        })).toEqual({
            public_server_id: '',
            public_relay_server: '',
            public_api_url: '',
        });
    });

    it('validateSettings rejects invalid host', () => {
        expect(() => validateSettings({ public_server_id: 'not valid host!!' }))
            .toThrow('invalid_public_host');
    });

    it('validateSettings rejects invalid API URL', () => {
        expect(() => validateSettings({ public_api_url: 'ftp://bad' }))
            .toThrow('invalid_public_api_url');
    });

    it('isEnvOverrideActive detects any configured value', () => {
        expect(isEnvOverrideActive({
            public_server_id: '',
            public_relay_server: '',
            public_api_url: '',
        })).toBe(false);
        expect(isEnvOverrideActive({
            public_server_id: '',
            public_relay_server: '',
            public_api_url: 'https://api.example.com',
        })).toBe(true);
    });

    it('parseEnvFile and upsertEnvKey persist public endpoint keys', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-public-endpoints-'));
        const envPath = path.join(tmpDir, '.env');
        try {
            let content = 'PORT=5000\n';
            const normalized = normalizeSettings({
                public_server_id: 'remote.example.com',
                public_relay_server: 'remote.example.com',
                public_api_url: 'https://api.example.com',
            });
            content = upsertEnvKey(content, 'PUBLIC_SERVER_ID', normalized.public_server_id);
            content = upsertEnvKey(content, 'PUBLIC_RELAY_SERVER', normalized.public_relay_server);
            content = upsertEnvKey(content, 'PUBLIC_API_URL', normalized.public_api_url);
            fs.writeFileSync(envPath, content, 'utf8');

            const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
            expect(parsed.PUBLIC_SERVER_ID).toBe('remote.example.com');
            expect(parsed.PUBLIC_RELAY_SERVER).toBe('remote.example.com');
            expect(parsed.PUBLIC_API_URL).toBe('https://api.example.com');
            expect(parsed.PORT).toBe('5000');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
