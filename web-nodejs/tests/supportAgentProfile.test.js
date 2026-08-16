'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

describe('supportAgentProfile', () => {
    let profile;
    const prevTtl = process.env.BETTERDESK_AGENT_PROFILE_TTL_DAYS;

    beforeEach(() => {
        jest.resetModules();
        process.env.BETTERDESK_AGENT_PROFILE_TTL_DAYS = '365';
        jest.doMock('../services/keyService', () => ({
            getPublicKey: () => 'test-pub-key',
            resolvePublicKey: async () => 'test-pub-key',
        }));
        jest.doMock('../services/agentBundleConnection', () => ({
            defaultServerHost: () => 'support.example.test',
            buildServerUrls: (host, useHttps) => {
                const scheme = useHttps ? 'https' : 'http';
                const ws = useHttps ? 'wss' : 'ws';
                return {
                    address: `${scheme}://${host}`,
                    api_url: `${scheme}://${host}/api`,
                    cdap_port: 21122,
                    cdap_url: `${ws}://${host}:21122/cdap`,
                };
            },
        }));
        profile = require('../services/supportAgentProfile');
    });

    afterEach(() => {
        if (prevTtl === undefined) delete process.env.BETTERDESK_AGENT_PROFILE_TTL_DAYS;
        else process.env.BETTERDESK_AGENT_PROFILE_TTL_DAYS = prevTtl;
        jest.resetModules();
    });

    function validProfile(overrides = {}) {
        return {
            bundle_id: 'bundle-test',
            profile_issued_at: '2026-01-01T00:00:00.000Z',
            profile_expires_at: '2099-01-01T00:00:00.000Z',
            allowed_endpoints: [
                'https://support.example.test',
                'https://support.example.test/api',
                'wss://support.example.test:21122/cdap',
            ],
            server: {
                address: 'https://support.example.test',
                api_url: 'https://support.example.test/api',
                cdap_url: 'wss://support.example.test:21122/cdap',
            },
            ...overrides,
        };
    }

    it('accepts a complete future profile', () => {
        expect(profile.isReleaseSupportProfileValid(validProfile())).toBe(true);
        expect(() => profile.assertReleaseSupportProfile(validProfile())).not.toThrow();
    });

    it('rejects incomplete and expired profiles', () => {
        expect(profile.isReleaseSupportProfileValid({})).toBe(false);
        expect(profile.isReleaseSupportProfileValid(validProfile({
            profile_expires_at: '2020-01-01T00:00:00.000Z',
        }))).toBe(false);
        expect(profile.isReleaseSupportProfileValid(validProfile({
            allowed_endpoints: ['https://a', 'https://b'],
        }))).toBe(false);
        expect(profile.isReleaseSupportProfileValid(validProfile({
            server: {
                address: 'https://support.example.test',
                api_url: 'https://support.example.test/api',
                cdap_url: 'wss://support.example.test:21122/cdap',
                cert_pin: 'not-a-sha256-pin',
            },
        }))).toBe(false);
    });

    it('addSupportProfileValidity sets dates and at least 3 endpoints', () => {
        const branding = {
            server: {
                address: 'https://support.example.test',
                api_url: 'https://support.example.test/api',
                cdap_url: 'wss://support.example.test:21122/cdap',
            },
        };
        const now = new Date('2026-08-06T00:00:00.000Z');
        profile.addSupportProfileValidity(branding, now);
        expect(branding.profile_issued_at).toBe(now.toISOString());
        expect(Date.parse(branding.profile_expires_at)).toBeGreaterThan(now.getTime());
        expect(branding.allowed_endpoints.length).toBeGreaterThanOrEqual(3);
    });

    it('refreshSupportAgentBranding injects server urls and strips enrollment token', async () => {
        const out = await profile.refreshSupportAgentBranding({
            server_host: 'support.example.test',
            use_https: true,
            enrollment_token: 'secret',
            has_enrollment_token: true,
        });
        expect(out.server.address).toMatch(/^https:\/\//);
        expect(out.server.api_url).toMatch(/\/api$/);
        expect(out.server.cdap_url).toMatch(/^wss:\/\//);
        expect(out.server_key).toBe('test-pub-key');
        expect(out.enrollment_token).toBeUndefined();
        expect(out.has_enrollment_token).toBeUndefined();
    });
});
