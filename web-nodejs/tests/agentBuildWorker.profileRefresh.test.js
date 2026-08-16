'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('agentBuildWorker profile refresh on rebuild', () => {
    let worker;
    let tmpDir;
    let mockDb;
    let mockHash;

    beforeEach(() => {
        jest.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-refresh-'));
        process.env.BETTERDESK_DATA_DIR = tmpDir;

        mockHash = jest.fn((branding) => `hash-${branding.profile_issued_at || 'none'}`);
        mockDb = {
            getAgentBundle: jest.fn(),
            listAgentBundles: jest.fn(),
            updateAgentBundle: jest.fn(async () => ({})),
            getAgentBundleBuild: jest.fn(async () => null),
            upsertAgentBundleBuild: jest.fn(async () => ({})),
            listAgentBundleBuildsForHash: jest.fn(async () => []),
        };

        jest.doMock('../services/database', () => mockDb);
        jest.doMock('../services/agentBundleService', () => ({
            PLATFORMS: [
                { platform: 'windows', arch: 'x86_64', format: 'portable' },
                { platform: 'linux', arch: 'x86_64', format: 'portable' },
            ],
            hashBranding: mockHash,
            publicBundleId: (row) => row.bundle_id,
        }));
        jest.doMock('../services/keyService', () => ({
            getPublicKey: () => 'test-pub-key',
            resolvePublicKey: async () => 'test-pub-key',
        }));
        jest.doMock('../services/agentBundleConnection', () => ({
            defaultServerHost: () => 'support.example.test',
            buildServerUrls: () => ({
                address: 'https://support.example.test',
                api_url: 'https://support.example.test/api',
                cdap_port: 21122,
                cdap_url: 'wss://support.example.test:21122/cdap',
            }),
        }));

        worker = require('../services/agentBuildWorker');
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) { /* ok */ }
        jest.resetModules();
    });

    function expiredBundle() {
        return {
            bundle_id: 'bundle-1',
            name: 'Test',
            slug: 'test',
            product_type: 'support-agent',
            revoked: false,
            branding_hash: 'old-hash',
            branding: JSON.stringify({
                bundle_id: 'bundle-1',
                company_name: 'Acme',
                server_host: 'support.example.test',
                use_https: true,
                profile_issued_at: '2020-01-01T00:00:00.000Z',
                profile_expires_at: '2021-01-01T00:00:00.000Z',
                allowed_endpoints: ['https://a'],
                server: {
                    address: 'https://support.example.test',
                    api_url: 'https://support.example.test/api',
                    cdap_url: 'wss://support.example.test:21122/cdap',
                },
            }),
        };
    }

    function validBundle() {
        const branding = {
            bundle_id: 'bundle-2',
            company_name: 'Acme',
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
        };
        return {
            bundle_id: 'bundle-2',
            name: 'Valid',
            slug: 'valid',
            product_type: 'support-agent',
            revoked: false,
            branding_hash: 'valid-hash',
            branding: JSON.stringify(branding),
        };
    }

    it('rebuildBundleById refreshes expired profile and enqueues new hash', async () => {
        mockDb.getAgentBundle.mockResolvedValue(expiredBundle());
        const result = await worker.rebuildBundleById('bundle-1');
        expect(result.success).toBe(true);
        expect(mockDb.updateAgentBundle).toHaveBeenCalledTimes(1);
        const updateArg = mockDb.updateAgentBundle.mock.calls[0][1];
        const saved = JSON.parse(updateArg.branding);
        expect(Date.parse(saved.profile_expires_at)).toBeGreaterThan(Date.now());
        expect(saved.allowed_endpoints.length).toBeGreaterThanOrEqual(3);
        expect(result.brandingHash).not.toBe('old-hash');
        expect(mockDb.upsertAgentBundleBuild).toHaveBeenCalled();
        expect(mockDb.upsertAgentBundleBuild.mock.calls[0][0].brandingHash).toBe(result.brandingHash);
    });

    it('rebuildBundleById keeps hash when profile is valid', async () => {
        mockDb.getAgentBundle.mockResolvedValue(validBundle());
        const result = await worker.rebuildBundleById('bundle-2');
        expect(result.success).toBe(true);
        expect(mockDb.updateAgentBundle).not.toHaveBeenCalled();
        expect(result.brandingHash).toBe('valid-hash');
    });

    it('requeueAllBundleBuilds refreshes stale profiles before enqueue', async () => {
        mockDb.listAgentBundles.mockResolvedValue([expiredBundle(), validBundle()]);
        const result = await worker.requeueAllBundleBuilds();
        expect(result.bundles).toBe(2);
        expect(mockDb.updateAgentBundle).toHaveBeenCalledTimes(1);
    });
});
