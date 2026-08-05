'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SOURCE_COMMIT = '6c578292e8ebbbec708b76986ba8c4bc7c509747';
const WORKFLOW_COMMIT = 'c'.repeat(40);

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const item of entries) {
        const name = Buffer.from(item.name);
        const content = Buffer.from(item.content || '');
        const checksum = crc32(content);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(content.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, content);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x0314, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(content.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((item.mode || 0o100600) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + content.length;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, end]);
}

describe('GitHub Real Client provider', () => {
    let Provider;
    let provider;
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-provider-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        process.env.DATA_DIR = tempDir;
        process.env.REAL_CLIENT_GITHUB_TOKEN = 'test-provider-token-never-a-secret';
        process.env.REAL_CLIENT_GITHUB_OWNER = 'example-org';
        process.env.REAL_CLIENT_GITHUB_REPO = 'central-builds';
        process.env.REAL_CLIENT_GITHUB_REF = 'main';
        process.env.REAL_CLIENT_GITHUB_WORKFLOW_COMMIT = WORKFLOW_COMMIT;
        process.env.REAL_CLIENT_GITHUB_MATRIX = '{"windows-x64-exe":["1.4.9"]}';
        process.env.REAL_CLIENT_GITHUB_REVISIONS = JSON.stringify({ '1.4.9': SOURCE_COMMIT });
        process.env.REAL_CLIENT_GITHUB_WORKFLOWS = '{"windows":"real-client-build.yml"}';
        process.env.REAL_CLIENT_PUBLIC_BASE_URL = 'https://console.example.com';
        process.env.REAL_CLIENT_PAYLOAD_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
        jest.resetModules();
        Provider = require('../services/githubRealClientBuildProvider');
        provider = new Provider();
    });

    afterEach(async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        delete process.env.DATA_DIR;
        for (const key of Object.keys(process.env)) if (key.startsWith('REAL_CLIENT_')) delete process.env[key];
    });

    test('advertises only explicitly verified targets and never exposes credentials', () => {
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(true);
        expect(capabilities.targets.map((target) => target.id)).toEqual(['windows-x64-exe']);
        expect(capabilities.versions).toEqual(['1.4.9']);
        expect(capabilities.combinations).toEqual(['windows-x64-exe@1.4.9']);
        expect(JSON.stringify(capabilities)).not.toContain('test-provider-token-never-a-secret');
        expect(JSON.stringify(capabilities)).not.toContain('central-builds');
    });

    test('dispatches only opaque build metadata and encrypted payload URL', async () => {
        provider.client.post = jest.fn().mockResolvedValue({ status: 204, data: '' });
        const target = provider.capabilities().targets[0];
        await provider.dispatch({
            build: {
                id: '44444444-4444-4444-8444-444444444444',
                rustdesk_version: '1.4.9',
                source_commit: SOURCE_COMMIT,
            },
            target,
            payloadUrl: 'https://console.example.com/api/generator/real-client/payload/44444444-4444-4444-8444-444444444444',
        });
        const requestBody = provider.client.post.mock.calls[0][1];
        expect(Object.keys(requestBody.inputs).sort()).toEqual(['artifact_retention_days', 'build_id', 'payload_url', 'rustdesk_version', 'source_commit', 'target', 'workflow_commit']);
        expect(requestBody.inputs.source_commit).toBe(SOURCE_COMMIT);
        expect(requestBody.inputs.workflow_commit).toBe(WORKFLOW_COMMIT);
        expect(requestBody.inputs.artifact_retention_days).toBe('30');
        expect(JSON.stringify(requestBody)).not.toContain('test-provider-token-never-a-secret');
        expect(JSON.stringify(requestBody)).not.toMatch(/password|private_key|signing/i);
    });

    test('disables dispatch for an invalid public origin or unknown target', () => {
        provider.settings.publicBaseUrl = 'https://console.example.com/unexpected-path';
        provider.settings.verifiedMatrix = {
            'windows-x64-exe': ['1.4.9'],
            'made-up-target': ['1.4.9'],
        };
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(false);
        expect(capabilities.reason).toContain('origin-only REAL_CLIENT_PUBLIC_BASE_URL');
        expect(capabilities.reason).toContain('made-up-target');
    });

    test('fails closed without an explicit workflow mapping or with an insecure API endpoint', () => {
        provider.settings.githubWorkflows = { windows: '../unsafe/workflow.yml' };
        provider.settings.githubApiUrl = 'http://api.example.com';
        provider.settings.githubRef = '../unsafe';
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(false);
        expect(capabilities.reason).toContain('REAL_CLIENT_GITHUB_WORKFLOWS mappings for: windows-x64-exe');
        expect(capabilities.reason).toContain('HTTPS REAL_CLIENT_GITHUB_API_URL');
        expect(capabilities.reason).toContain('REAL_CLIENT_GITHUB_REF');
    });

    test('fails closed when an advertised version is not pinned to an immutable commit', () => {
        provider.settings.sourceRevisions = {};
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(false);
        expect(capabilities.combinations).toEqual([]);
        expect(capabilities.reason).toContain('REAL_CLIENT_GITHUB_REVISIONS commit for 1.4.9');

        provider.settings.sourceRevisions = { '1.4.9': 'e'.repeat(40) };
        const wrongCommit = provider.capabilities();
        expect(wrongCommit.enabled).toBe(false);
        expect(wrongCommit.combinations).toEqual([]);
        expect(wrongCommit.reason).toContain('approved bundled adapter commit for 1.4.9');
    });

    test('cannot advertise a target or revision rejected by the bundled central adapter', () => {
        provider.settings.verifiedMatrix = {
            'windows-x86-exe': ['1.4.9'],
            'windows-x64-exe': ['1.4.8'],
        };
        provider.settings.sourceRevisions = {
            '1.4.9': SOURCE_COMMIT,
            '1.4.8': 'd'.repeat(40),
        };
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(false);
        expect(capabilities.targets).toEqual([]);
        expect(capabilities.combinations).toEqual([]);
        expect(capabilities.reason).toContain('bundled central adapter: windows-x86-exe');
        expect(capabilities.reason).toContain('bundled central adapter for windows-x64-exe: 1.4.8');
    });

    test('fails closed when the central build workflow revision is not pinned', () => {
        provider.settings.githubWorkflowCommit = '';
        const capabilities = provider.capabilities();
        expect(capabilities.enabled).toBe(false);
        expect(capabilities.reason).toContain('REAL_CLIENT_GITHUB_WORKFLOW_COMMIT');
    });

    test('rejects a payload URL that is not the exact trusted build URL', async () => {
        const target = provider.capabilities().targets[0];
        await expect(provider.dispatch({
            build: {
                id: '44444444-4444-4444-8444-444444444444',
                rustdesk_version: '1.4.9',
                source_commit: SOURCE_COMMIT,
            },
            target,
            payloadUrl: 'https://other.example.com/api/generator/real-client/payload/44444444-4444-4444-8444-444444444444',
        })).rejects.toThrow(/trusted origin/);
    });

    test('paginates busy workflow history while correlating the exact build ID', async () => {
        const createdAt = new Date().toISOString();
        const unrelated = Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            display_title: `Real Client unrelated-${index}`,
            name: 'BetterDesk Real Client',
            created_at: createdAt,
            head_sha: WORKFLOW_COMMIT,
        }));
        const expected = {
            id: 501,
            display_title: 'Real Client 44444444-4444-4444-8444-444444444444',
            created_at: createdAt,
            head_sha: WORKFLOW_COMMIT,
        };
        provider.client.get = jest.fn()
            .mockResolvedValueOnce({ data: { workflow_runs: unrelated } })
            .mockResolvedValueOnce({ data: { workflow_runs: [expected] } });
        const run = await provider.findRun({
            id: '44444444-4444-4444-8444-444444444444',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: createdAt,
        });
        expect(run).toEqual(expected);
        expect(provider.client.get).toHaveBeenCalledTimes(2);
        expect(provider.client.get.mock.calls[1][1].params.page).toBe(2);
        expect(provider.client.get.mock.calls[1][1].params).not.toHaveProperty('branch');
    });

    test('does not correlate a lookalike run from an unpinned workflow revision', async () => {
        const createdAt = new Date().toISOString();
        provider.client.get = jest.fn().mockResolvedValue({
            data: {
                workflow_runs: [{
                    id: 777,
                    display_title: 'Real Client 44444444-4444-4444-8444-444444444444',
                    created_at: createdAt,
                    head_sha: 'd'.repeat(40),
                }],
            },
        });

        await expect(provider.findRun({
            id: '44444444-4444-4444-8444-444444444444',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: createdAt,
        })).resolves.toBeNull();
    });

    test('keeps an immediate cancellation pending until the dispatched run can be identified', async () => {
        provider.findRun = jest.fn().mockResolvedValue(null);
        provider.client.post = jest.fn();
        const result = await provider.cancel({
            id: '44444444-4444-4444-8444-444444444444',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: new Date().toISOString(),
        });
        expect(result).toEqual(expect.objectContaining({
            status: 'cancelling',
            providerStatus: 'waiting_to_cancel',
        }));
        expect(provider.client.post).not.toHaveBeenCalled();
    });

    test('finds and cancels a dispatch whose run ID was not returned initially', async () => {
        provider.findRun = jest.fn().mockResolvedValue({
            id: 9876,
            html_url: 'https://github.com/example-org/central-builds/actions/runs/9876',
        });
        provider.client.post = jest.fn().mockResolvedValue({ status: 202 });
        const result = await provider.cancel({
            id: '44444444-4444-4444-8444-444444444444',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: new Date().toISOString(),
        });
        expect(result).toEqual(expect.objectContaining({
            status: 'cancelling',
            providerRunId: '9876',
            providerStatus: 'cancel_requested',
        }));
        expect(provider.client.post.mock.calls[0][0]).toContain('/actions/runs/9876/cancel');
    });

    test('retries cancellation during inspection after a previously undiscoverable run appears', async () => {
        provider.findRun = jest.fn().mockResolvedValue({
            id: 9877,
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/example-org/central-builds/actions/runs/9877',
        });
        provider.client.post = jest.fn().mockResolvedValue({ status: 202 });
        const result = await provider.inspect({
            id: '44444444-4444-4444-8444-444444444444',
            status: 'cancelling',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: new Date().toISOString(),
        });
        expect(result).toEqual(expect.objectContaining({
            status: 'cancelling',
            providerRunId: '9877',
            providerStatus: 'cancel_requested',
        }));
        expect(provider.client.post.mock.calls[0][0]).toContain('/actions/runs/9877/cancel');
    });

    test('does not revert a cancelling build to building on a GitHub cancellation race', async () => {
        provider.client.get = jest.fn().mockResolvedValue({
            data: {
                id: 9878,
                status: 'in_progress',
                conclusion: null,
                html_url: 'https://github.com/example-org/central-builds/actions/runs/9878',
            },
        });
        provider.client.post = jest.fn().mockRejectedValue({ response: { status: 409, data: { message: 'Conflict' } } });
        const result = await provider.inspect({
            id: '44444444-4444-4444-8444-444444444444',
            status: 'cancelling',
            provider_run_id: '9878',
            platform: 'windows', arch: 'x86_64', package_type: 'exe',
            queued_at: new Date().toISOString(),
        });
        expect(result).toEqual(expect.objectContaining({
            status: 'cancelling',
            providerStatus: 'waiting_for_terminal_state',
        }));
    });

    test('extracts exactly one safe root artifact and records integrity metadata', async () => {
        const zipPath = path.join(tempDir, 'artifact.zip');
        fs.writeFileSync(zipPath, createStoredZip([{ name: 'client.exe', content: 'binary-data' }]));

        const result = await provider.extractExpectedArtifact(zipPath, tempDir, {
            package_type: 'exe',
            config_snapshot_json: JSON.stringify({ executableName: 'client' }),
        });

        expect(result.artifactName).toBe('client.exe');
        expect(result.artifactSize).toBe(Buffer.byteLength('binary-data'));
        expect(result.artifactSha256).toBe(crypto.createHash('sha256').update('binary-data').digest('hex'));
        expect(await fs.promises.readFile(result.artifactPath, 'utf8')).toBe('binary-data');
    });

    test.each([
        ['nested paths', [{ name: 'folder/client.exe', content: 'binary' }], /found 0/],
        ['unexpected executable names', [{ name: 'other.exe', content: 'binary' }], /found 0/],
        ['multiple candidates', [
            { name: 'client.exe', content: 'one' },
            { name: 'client-portable.exe', content: 'two' },
        ], /found 2/],
        ['symbolic links', [{ name: 'client.exe', content: 'target', mode: 0o120777 }], /found 0/],
    ])('rejects %s in downloaded artifacts', async (_label, entries, expectedError) => {
        const zipPath = path.join(tempDir, 'invalid.zip');
        fs.writeFileSync(zipPath, createStoredZip(entries));
        await expect(provider.extractExpectedArtifact(zipPath, tempDir, {
            package_type: 'exe',
            config_snapshot_json: JSON.stringify({ executableName: 'client' }),
        })).rejects.toThrow(expectedError);
    });

    test('enforces the configured extracted artifact size limit', async () => {
        const zipPath = path.join(tempDir, 'oversized.zip');
        fs.writeFileSync(zipPath, createStoredZip([{ name: 'client.exe', content: 'too-large' }]));
        provider.settings.maxArtifactBytes = 4;
        await expect(provider.extractExpectedArtifact(zipPath, tempDir, {
            package_type: 'exe',
            config_snapshot_json: JSON.stringify({ executableName: 'client' }),
        })).rejects.toThrow(/size limit/);
    });

    test('rejects artifact archives with an excessive central-directory entry count', async () => {
        const zipPath = path.join(tempDir, 'too-many-entries.zip');
        const entries = Array.from({ length: 2049 }, (_, index) => ({
            name: `padding-${index}.txt`,
            content: '',
        }));
        fs.writeFileSync(zipPath, createStoredZip(entries));

        await expect(provider.extractExpectedArtifact(zipPath, tempDir, {
            package_type: 'exe',
            config_snapshot_json: JSON.stringify({ executableName: 'client' }),
        })).rejects.toThrow(/entry count/);
    });

    test('removes the entire private artifact directory after a failed download validation', async () => {
        const buildId = '44444444-4444-4444-8444-444444444445';
        provider.client.get = jest.fn()
            .mockResolvedValueOnce({ data: { artifacts: [{ id: 91, name: `real-client-${buildId}`, expired: false }] } })
            .mockResolvedValueOnce({ data: require('stream').Readable.from(Buffer.from('not-a-zip')) });

        await expect(provider.downloadArtifact({
            id: buildId,
            package_type: 'exe',
            config_snapshot_json: JSON.stringify({ executableName: 'client' }),
        }, 1234)).rejects.toThrow();

        expect(fs.existsSync(path.join(tempDir, 'real-client-artifacts', buildId))).toBe(false);
    });
});
