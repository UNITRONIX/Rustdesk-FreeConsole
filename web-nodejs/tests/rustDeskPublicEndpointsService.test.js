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
    writePublicEndpointSettingsToEnv,
    readPublicEndpointEnv,
    readPanelPublicHostValue,
    ensureMigratedPublicEndpoints,
    getDurableEnvPath,
    DURABLE_BASENAME,
    _setPathsForTests,
} = require('../services/rustDeskPublicEndpointsService');

describe('rustDeskPublicEndpointsService', () => {
    const originalPublicServerId = process.env.PUBLIC_SERVER_ID;
    const originalPublicRelay = process.env.PUBLIC_RELAY_SERVER;
    const originalPublicApi = process.env.PUBLIC_API_URL;
    const originalPanelHost = process.env.PANEL_PUBLIC_HOST;

    let tmpRoot;
    let dataDir;
    let envPath;
    let durablePath;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-public-endpoints-'));
        dataDir = path.join(tmpRoot, 'data');
        envPath = path.join(tmpRoot, '.env');
        durablePath = path.join(dataDir, DURABLE_BASENAME);
        fs.mkdirSync(dataDir, { recursive: true });
        _setPathsForTests({ envPath, durablePath, dataDir });

        delete process.env.PUBLIC_SERVER_ID;
        delete process.env.PUBLIC_RELAY_SERVER;
        delete process.env.PUBLIC_API_URL;
        delete process.env.PANEL_PUBLIC_HOST;
    });

    afterEach(() => {
        _setPathsForTests(null);
        if (originalPublicServerId === undefined) delete process.env.PUBLIC_SERVER_ID;
        else process.env.PUBLIC_SERVER_ID = originalPublicServerId;
        if (originalPublicRelay === undefined) delete process.env.PUBLIC_RELAY_SERVER;
        else process.env.PUBLIC_RELAY_SERVER = originalPublicRelay;
        if (originalPublicApi === undefined) delete process.env.PUBLIC_API_URL;
        else process.env.PUBLIC_API_URL = originalPublicApi;
        if (originalPanelHost === undefined) delete process.env.PANEL_PUBLIC_HOST;
        else process.env.PANEL_PUBLIC_HOST = originalPanelHost;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

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

    it('validateSettings rejects CR/LF injection in host', () => {
        expect(() => validateSettings({
            public_server_id: 'evil.example.com\nSESSION_SECRET=hacked',
        })).toThrow('invalid_public_host');
    });

    it('validateSettings rejects CR/LF injection in API URL', () => {
        expect(() => validateSettings({
            public_api_url: 'https://api.example.com\nOTHER=1',
        })).toThrow();
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
    });

    it('writePublicEndpointSettingsToEnv writes durable and mirrors .env', () => {
        writePublicEndpointSettingsToEnv({
            public_server_id: 'gateway.example.net',
            public_relay_server: 'gateway.example.net',
            public_api_url: 'https://api.example.net:21121',
        });

        expect(fs.existsSync(durablePath)).toBe(true);
        expect(getDurableEnvPath()).toBe(durablePath);

        const durable = parseEnvFile(fs.readFileSync(durablePath, 'utf8'));
        expect(durable.PUBLIC_SERVER_ID).toBe('gateway.example.net');
        expect(durable.PUBLIC_RELAY_SERVER).toBe('gateway.example.net');
        expect(durable.PUBLIC_API_URL).toBe('https://api.example.net:21121');

        const legacy = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
        expect(legacy.PUBLIC_SERVER_ID).toBe('gateway.example.net');
        expect(process.env.PUBLIC_SERVER_ID).toBe('gateway.example.net');
    });

    it('read prefers non-empty process.env over durable over .env', () => {
        fs.writeFileSync(envPath, 'PUBLIC_SERVER_ID=from-legacy.example\n', 'utf8');
        fs.writeFileSync(durablePath, 'PUBLIC_SERVER_ID=from-durable.example\n', 'utf8');

        let settings = readPublicEndpointEnv();
        expect(settings.public_server_id).toBe('from-durable.example');

        process.env.PUBLIC_SERVER_ID = 'from-compose.example';
        settings = readPublicEndpointEnv();
        expect(settings.public_server_id).toBe('from-compose.example');
    });

    it('empty process.env does not mask durable values', () => {
        fs.writeFileSync(durablePath, 'PUBLIC_SERVER_ID=durable.example\n', 'utf8');
        process.env.PUBLIC_SERVER_ID = '';
        const settings = readPublicEndpointEnv();
        expect(settings.public_server_id).toBe('durable.example');
    });

    it('survives .env loss after recreate (durable remains)', () => {
        writePublicEndpointSettingsToEnv({
            public_server_id: 'gateway.example.net',
            public_relay_server: 'relay.example.net',
            public_api_url: 'https://api.example.net:21121',
        });
        delete process.env.PUBLIC_SERVER_ID;
        delete process.env.PUBLIC_RELAY_SERVER;
        delete process.env.PUBLIC_API_URL;
        fs.unlinkSync(envPath);

        const settings = readPublicEndpointEnv();
        expect(settings.public_server_id).toBe('gateway.example.net');
        expect(settings.public_relay_server).toBe('relay.example.net');
        expect(settings.public_api_url).toBe('https://api.example.net:21121');
    });

    it('migrates from .env into durable when durable is empty', () => {
        fs.writeFileSync(envPath, [
            'PUBLIC_SERVER_ID=migrated.example',
            'PUBLIC_RELAY_SERVER=migrated-relay.example',
            'PUBLIC_API_URL=https://api.migrated.example',
            'PANEL_PUBLIC_HOST=panel.migrated.example',
        ].join('\n') + '\n', 'utf8');

        ensureMigratedPublicEndpoints();

        expect(fs.existsSync(durablePath)).toBe(true);
        const durable = parseEnvFile(fs.readFileSync(durablePath, 'utf8'));
        expect(durable.PUBLIC_SERVER_ID).toBe('migrated.example');
        expect(durable.PUBLIC_RELAY_SERVER).toBe('migrated-relay.example');
        expect(durable.PUBLIC_API_URL).toBe('https://api.migrated.example');
        expect(durable.PANEL_PUBLIC_HOST).toBe('panel.migrated.example');
    });

    it('migration never overwrites non-empty durable', () => {
        fs.writeFileSync(durablePath, 'PUBLIC_SERVER_ID=keep.example\n', 'utf8');
        fs.writeFileSync(envPath, 'PUBLIC_SERVER_ID=should-not-win.example\n', 'utf8');

        ensureMigratedPublicEndpoints();

        const durable = parseEnvFile(fs.readFileSync(durablePath, 'utf8'));
        expect(durable.PUBLIC_SERVER_ID).toBe('keep.example');
    });

    it('readPanelPublicHostValue uses same precedence', () => {
        fs.writeFileSync(durablePath, 'PANEL_PUBLIC_HOST=durable-panel.example\n', 'utf8');
        expect(readPanelPublicHostValue()).toBe('durable-panel.example');

        process.env.PANEL_PUBLIC_HOST = 'compose-panel.example';
        expect(readPanelPublicHostValue()).toBe('compose-panel.example');
    });
});
