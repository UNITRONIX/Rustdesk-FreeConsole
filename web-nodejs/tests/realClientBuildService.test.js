'use strict';

const mockDb = {
    getRealClientConfig: jest.fn(),
    getRealClientBuild: jest.fn(),
    getTenantById: jest.fn(),
    updateRealClientConfig: jest.fn(),
    updateRealClientBuild: jest.fn(),
};

jest.mock('../services/database', () => mockDb);

const configService = require('../services/realClientConfigService');
const buildService = require('../services/realClientBuildService');

function validConfig(overrides = {}) {
    return {
        ...configService.defaultConfig(),
        idServer: 'id.example.com:21116',
        relayServer: 'relay.example.com:21117',
        apiServer: 'https://api.example.com',
        publicKey: Buffer.alloc(32, 7).toString('base64'),
        ...overrides,
    };
}

describe('Real Client build service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        buildService.buildLocks.clear();
    });

    test('rejects oversized configuration metadata instead of silently truncating it', () => {
        const result = buildService.validateConfig({
            name: 'N'.repeat(121),
            description: 'D'.repeat(1001),
            config: validConfig(),
        });

        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'name', code: 'too_long' }),
            expect.objectContaining({ field: 'description', code: 'too_long' }),
        ]));
    });

    test('updates an explicitly selected organization instead of retaining the old tenant', async () => {
        const existing = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Client',
            organization_id: '1',
            build_provider: 'github',
        };
        mockDb.getRealClientConfig.mockResolvedValue(existing);
        mockDb.getTenantById.mockResolvedValue({ id: '2', name: 'New tenant' });
        mockDb.updateRealClientConfig.mockImplementation(async (id, data) => ({
            ...existing,
            id,
            organization_id: data.organizationId,
            description: data.description,
            config_json: data.configJson,
            assets_json: data.assetsJson,
            target_platform: data.targetPlatform,
            target_arch: data.targetArch,
            target_package: data.targetPackage,
            build_provider: data.buildProvider,
            rustdesk_version: data.rustdeskVersion,
        }));

        const result = await buildService.updateConfig(existing.id, {
            name: 'Client',
            description: 'Moved',
            organization_id: '2',
            config: validConfig(),
        });

        expect(result.valid).toBe(true);
        expect(mockDb.getTenantById).toHaveBeenCalledWith('2');
        expect(mockDb.updateRealClientConfig).toHaveBeenCalledWith(existing.id, expect.objectContaining({ organizationId: '2' }));
        expect(result.data.organization_id).toBe('2');
    });

    test('records a completion timestamp for terminal provider results', async () => {
        const build = {
            id: '22222222-2222-4222-8222-222222222222',
            config_id: null,
            status: 'building',
            finished_at: null,
            cancelled_at: null,
        };
        mockDb.updateRealClientBuild.mockImplementation(async (_id, fields) => ({
            ...build,
            status: fields.status,
            finished_at: fields.finishedAt,
        }));

        const updated = await buildService.applyBuildUpdate(build, { status: 'failed', errorMessage: 'Build failed' });

        expect(mockDb.updateRealClientBuild).toHaveBeenCalledWith(build.id, expect.objectContaining({
            status: 'failed',
            finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }));
        expect(updated.finished_at).toBeTruthy();
    });

    test('does not expose a non-HTTP provider link to the browser', () => {
        const serialized = buildService.serializeBuild({ id: 'build', provider_run_url: 'javascript:alert(1)' });
        expect(serialized.provider_run_url).toBeNull();
    });

    test.each([
        'http://github.example.com/run/1',
        'https://user:password@github.example.com/run/1',
    ])('does not expose an insecure or credential-bearing provider link: %s', (url) => {
        expect(buildService.serializeBuild({ id: 'build', provider_run_url: url }).provider_run_url).toBeNull();
    });

    test('masks structured secrets and private keys in provider diagnostics', () => {
        const serialized = buildService.serializeBuild({
            id: 'build',
            log_summary: 'failure {"password":"space secret", "token":"do-not-leak"}',
            error_message: '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----',
        });
        expect(JSON.stringify(serialized)).not.toContain('space secret');
        expect(JSON.stringify(serialized)).not.toContain('do-not-leak');
        expect(JSON.stringify(serialized)).not.toContain('secret material');
        expect(serialized.log_summary).toContain('[masked]');
    });

    test('rejects an unsafe one-time password before creating a build record', async () => {
        mockDb.getRealClientConfig.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            owner_user_id: 7,
        });
        const result = await buildService.createBuild({
            configId: '11111111-1111-4111-8111-111111111111',
            oneTimeSecrets: { permanentPassword: 'unsafe\npassword' },
        }, 7);
        expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 400 }));
        expect(result.errors[0]).toEqual(expect.objectContaining({ field: 'permanent_password', code: 'invalid_secret' }));
    });

    test('does not silently replace an empty batch selection with the saved default', () => {
        const result = buildService.normalizeBatchSelection([], []);
        expect(result.valid).toBe(false);
        expect(result.targets).toEqual([]);
        expect(result.variants).toEqual([]);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'targets', code: 'required' }),
            expect.objectContaining({ field: 'variants', code: 'required' }),
        ]));
    });

    test('keeps compatibility warnings separate from explicit per-target build adjustments', async () => {
        const target = configService.targetById('android-arm64-apk');
        mockDb.getRealClientConfig.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            config_json: JSON.stringify(validConfig({
                rustdeskVersion: '1.4.9',
                target: target.id,
                hideConnectionManager: true,
                approvalMode: 'password',
            })),
        });
        const provider = {
            id: 'matrix-provider',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({
                enabled: true,
                targets: [target],
                versions: ['1.4.9'],
                combinations: [`${target.id}@1.4.9`],
            }),
        };
        buildService.providers.set(provider.id, provider);
        try {
            const plan = await buildService.planBuildMatrix({
                configId: '11111111-1111-4111-8111-111111111111',
                providerId: provider.id,
            });
            const full = plan.entries.find((entry) => entry.target === target.id && entry.variant === 'client');
            const quick = plan.entries.find((entry) => entry.target === target.id && entry.variant === 'quicksupport');
            expect(full).toEqual(expect.objectContaining({
                enabled: true,
                requires_password: false,
                adjustments: expect.arrayContaining([
                    expect.objectContaining({ code: 'hide_connection_manager_omitted' }),
                ]),
            }));
            expect(quick).toEqual(expect.objectContaining({
                enabled: true,
                requires_password: false,
                adjustments: expect.arrayContaining([
                    expect.objectContaining({ code: 'android_quicksupport_installable' }),
                    expect.objectContaining({ code: 'quicksupport_profile' }),
                ]),
            }));
        } finally {
            buildService.providers.delete(provider.id);
        }
    });

    test('requires a one-time permanent password for a hidden connection manager build', async () => {
        const target = configService.targetById('windows-x64-exe');
        mockDb.getRealClientConfig.mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            owner_user_id: 7,
            config_json: JSON.stringify(validConfig({
                rustdeskVersion: '1.4.9',
                hideConnectionManager: true,
                approvalMode: 'password',
            })),
        });
        const provider = {
            id: 'guard-provider',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({
                enabled: true,
                targets: [target],
                versions: ['1.4.9'],
                combinations: ['windows-x64-exe@1.4.9'],
            }),
        };
        buildService.providers.set(provider.id, provider);
        try {
            const result = await buildService.createBuild({
                configId: '11111111-1111-4111-8111-111111111111',
                providerId: provider.id,
                oneTimeSecrets: {},
            }, 7);
            expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 400 }));
            expect(result.errors).toEqual(expect.arrayContaining([
                expect.objectContaining({ field: 'permanent_password', code: 'required' }),
            ]));
        } finally {
            buildService.providers.delete(provider.id);
        }
    });

    test('rejects an asset reference that is not present under the configuration owner', async () => {
        const result = {
            valid: true,
            errors: [],
            normalized: { assets: { icon: '33333333-3333-4333-8333-333333333333' } },
        };
        await buildService.validateAssets(result, 999999);
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'assets.icon', code: 'asset_not_found' }),
        ]));
    });

    test('serializes concurrent polls for one build and downloads a completed artifact only once', async () => {
        let stored = {
            id: '55555555-5555-4555-8555-555555555555',
            config_id: null,
            provider: 'test-provider',
            status: 'building',
            finished_at: null,
            cancelled_at: null,
        };
        mockDb.getRealClientBuild.mockImplementation(async () => ({ ...stored }));
        mockDb.updateRealClientBuild.mockImplementation(async (_id, fields) => {
            stored = {
                ...stored,
                status: fields.status || stored.status,
                artifact_path: fields.artifactPath || stored.artifact_path,
                artifact_name: fields.artifactName || stored.artifact_name,
                artifact_size: fields.artifactSize || stored.artifact_size,
                artifact_sha256: fields.artifactSha256 || stored.artifact_sha256,
                finished_at: fields.finishedAt || stored.finished_at,
            };
            return { ...stored };
        });
        const provider = {
            inspect: jest.fn(async () => {
                await new Promise((resolve) => setImmediate(resolve));
                return {
                    status: 'ready',
                    artifactPath: '/private/client.exe',
                    artifactName: 'client.exe',
                    artifactSize: 7,
                    artifactSha256: 'a'.repeat(64),
                };
            }),
        };
        buildService.providers.set('test-provider', provider);

        try {
            const [first, second] = await Promise.all([
                buildService.syncBuild(stored.id),
                buildService.syncBuild(stored.id),
            ]);

            expect(provider.inspect).toHaveBeenCalledTimes(1);
            expect(first.status).toBe('ready');
            expect(second.status).toBe('ready');
            expect(buildService.buildLocks.size).toBe(0);
        } finally {
            buildService.providers.delete('test-provider');
        }
    });

    test('keeps temporary GitHub API failures recoverable and clears the diagnostic after recovery', async () => {
        let stored = {
            id: '77777777-7777-4777-8777-777777777777',
            config_id: null,
            provider: 'resilient-provider',
            status: 'building',
            provider_status: 'in_progress',
            error_message: null,
            queued_at: new Date().toISOString(),
            finished_at: null,
            cancelled_at: null,
        };
        mockDb.getRealClientBuild.mockImplementation(async () => ({ ...stored }));
        mockDb.updateRealClientBuild.mockImplementation(async (_id, fields) => {
            stored = {
                ...stored,
                status: fields.status || stored.status,
                provider_status: Object.prototype.hasOwnProperty.call(fields, 'providerStatus')
                    ? fields.providerStatus : stored.provider_status,
                error_message: Object.prototype.hasOwnProperty.call(fields, 'errorMessage')
                    ? fields.errorMessage : stored.error_message,
            };
            return { ...stored };
        });
        const provider = {
            inspect: jest.fn()
                .mockRejectedValueOnce(new Error('GitHub API 503: temporarily overloaded'))
                .mockResolvedValueOnce({ status: 'building', providerStatus: 'in_progress' }),
        };
        buildService.providers.set('resilient-provider', provider);

        try {
            const unavailable = await buildService.syncBuild(stored.id);
            expect(unavailable.status).toBe('building');
            expect(unavailable.provider_status).toBe('sync_error');
            expect(unavailable.error_message).toContain('GitHub API 503');

            const recovered = await buildService.syncBuild(stored.id);
            expect(recovered.status).toBe('building');
            expect(recovered.provider_status).toBe('in_progress');
            expect(recovered.error_message).toBe('');
            expect(provider.inspect).toHaveBeenCalledTimes(2);
        } finally {
            buildService.providers.delete('resilient-provider');
        }
    });
});
