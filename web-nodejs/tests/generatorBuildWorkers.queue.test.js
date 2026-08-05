'use strict';

jest.mock('../services/database', () => ({
    listAgentBundles: jest.fn(),
    listAgentBundleBuildsForHash: jest.fn(),
    getAgentBundleBuild: jest.fn(),
    upsertAgentBundleBuild: jest.fn(),
    getAgentBundle: jest.fn(),
}));

jest.mock('../services/agentBundleService', () => ({
    PLATFORMS: [
        { platform: 'linux', arch: 'x64', format: 'portable', label: 'Linux portable' },
    ],
}));

jest.mock('../config/config', () => ({ dataDir: '/tmp/betterdesk-generator-worker-test' }));

const db = require('../services/database');
const supportWorker = require('../services/agentBuildWorker');
const agentClientWorker = require('../services/agentClientBuildWorker');
const rdclientWorker = require('../services/rdclientBuildWorker');

const bundles = [
    { branding_hash: 'legacy-support', product_type: 'agent', revoked: false },
    { branding_hash: 'support', product_type: 'support-agent', revoked: false },
    { branding_hash: 'client', product_type: 'agent-client', revoked: false },
    { branding_hash: 'rdclient', product_type: 'rdclient', revoked: false },
];

const buildsByHash = {
    'legacy-support': [{ branding_hash: 'legacy-support', status: 'queued', platform: 'linux', arch: 'x64', format: 'portable' }],
    support: [{ branding_hash: 'support', status: 'pending', platform: 'linux', arch: 'x64', format: 'portable' }],
    client: [{ branding_hash: 'client', status: 'queued', platform: 'linux', arch: 'x64', format: 'portable' }],
    rdclient: [{ branding_hash: 'rdclient', status: 'pending', platform: 'linux', arch: 'x64', format: 'portable' }],
};

describe('generator build workers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.listAgentBundles.mockResolvedValue(bundles);
        db.listAgentBundleBuildsForHash.mockImplementation(async (hash) => buildsByHash[hash] || []);
        db.getAgentBundleBuild.mockResolvedValue(null);
        db.upsertAgentBundleBuild.mockResolvedValue({});
    });

    test('claims both queued and pending records only for its product type', async () => {
        expect(typeof rdclientWorker.rebuildBundleById).toBe('function');
        expect(typeof rdclientWorker.requeuePlatformBuild).toBe('function');
        const support = await supportWorker._internals.listPendingBuilds(10);
        const client = await agentClientWorker._internals.listPendingBuilds(10);
        const rdclient = await rdclientWorker._internals.listPendingBuilds(10);

        expect(support.map((build) => build.branding_hash))
            .toEqual(expect.arrayContaining(['legacy-support', 'support']));
        expect(support).toHaveLength(2);
        expect(client.map((build) => build.branding_hash)).toEqual(['client']);
        expect(rdclient.map((build) => build.branding_hash)).toEqual(['rdclient']);
    });

    test('rebuild queues remain isolated by product worker', async () => {
        await supportWorker.requeueAllBundleBuilds();
        expect(db.upsertAgentBundleBuild.mock.calls.map(([job]) => job.brandingHash).sort())
            .toEqual(['legacy-support', 'support']);
        expect(db.upsertAgentBundleBuild.mock.calls.every(([job]) => job.status === 'queued')).toBe(true);

        db.upsertAgentBundleBuild.mockClear();
        await agentClientWorker.requeueAllBundleBuilds();
        expect(db.upsertAgentBundleBuild.mock.calls.map(([job]) => job.brandingHash))
            .toEqual(['client']);

        db.upsertAgentBundleBuild.mockClear();
        await rdclientWorker.requeueAllBundleBuilds();
        expect(db.upsertAgentBundleBuild.mock.calls.map(([job]) => job.brandingHash))
            .toEqual(['rdclient']);
    });
});
