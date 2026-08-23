'use strict';

const crypto = require('crypto');
const https = require('https');

describe('updateService server binary delivery', () => {
    let updateService;

    beforeEach(() => {
        jest.restoreAllMocks();
        delete require.cache[require.resolve('../services/updateService')];
        updateService = require('../services/updateService');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete require.cache[require.resolve('../services/updateService')];
    });

    it('accepts a manifest only for the requested target and exact commit', () => {
        const target = updateService.getServerBinaryTarget();
        const binary = Buffer.from('server-binary');
        const manifest = {
            commit: 'a'.repeat(40),
            version: '3.5.56',
            goos: target.goos,
            goarch: target.goarch,
            asset: target.assetName,
            size: binary.length,
            sha256: crypto.createHash('sha256').update(binary).digest('hex'),
        };

        expect(updateService.validateServerBinaryManifest(manifest, binary, {
            ...target,
            remoteSHA: manifest.commit,
        })).toBeNull();
        expect(updateService.validateServerBinaryManifest({
            ...manifest,
            commit: 'b'.repeat(40),
        }, binary, { ...target, remoteSHA: manifest.commit })).toMatch(/commit mismatch/);
        expect(updateService.validateServerBinaryManifest({
            ...manifest,
            sha256: '0'.repeat(64),
        }, binary, { ...target, remoteSHA: manifest.commit })).toMatch(/SHA-256/);
    });

    it('rejects unsafe artifact archive paths', () => {
        expect(updateService.getSafeZipEntryName('../betterdesk-server')).toBeNull();
        expect(updateService.getSafeZipEntryName('/betterdesk-server')).toBeNull();
        expect(updateService.getSafeZipEntryName('C:\\temp\\betterdesk-server')).toBeNull();
        expect(updateService.getSafeZipEntryName('server/betterdesk-server')).toBe('server/betterdesk-server');
    });

    it('finds a successful exact-commit Actions artifact for the current target', async () => {
        const remoteSHA = 'c'.repeat(40);
        const target = updateService.getServerBinaryTarget();
        const runId = 12345;
        const routes = new Map([
            [
                `/repos/UNITRONIX/BetterDesk/actions/workflows/release-server.yml/runs?head_sha=${remoteSHA}&per_page=20`,
                {
                    total_count: 1,
                    workflow_runs: [{
                        id: runId,
                        head_sha: remoteSHA,
                        status: 'completed',
                        conclusion: 'success',
                        updated_at: '2026-08-23T18:00:00Z',
                        name: 'Build & Release Go Server',
                    }],
                },
            ],
            [
                `/repos/UNITRONIX/BetterDesk/actions/runs/${runId}/jobs?per_page=100`,
                {
                    jobs: [
                        { name: 'build (linux, amd64, linux-amd64)', conclusion: 'success' },
                        { name: 'build (linux, arm64, linux-arm64)', conclusion: 'success' },
                        { name: 'build (windows, amd64, windows-amd64.exe)', conclusion: 'success' },
                    ],
                },
            ],
            [
                `/repos/UNITRONIX/BetterDesk/actions/runs/${runId}/artifacts?per_page=100`,
                {
                    artifacts: [{
                        id: 67890,
                        name: `betterdesk-server-${target.suffix}`,
                        expired: false,
                        size_in_bytes: 1234567,
                        archive_download_url: `https://api.github.com/artifacts/67890/zip`,
                    }],
                },
            ],
        ]);

        jest.spyOn(https, 'get').mockImplementation((options, callback) => {
            const request = {
                on: jest.fn(),
                setTimeout: jest.fn(),
                destroy: jest.fn(),
            };
            const route = typeof options === 'string'
                ? new URL(options).pathname + new URL(options).search
                : options.path;
            const body = routes.get(route);
            process.nextTick(() => {
                const response = {
                    statusCode: body ? 200 : 404,
                    headers: {},
                    on(event, handler) {
                        if (event === 'data' && body) process.nextTick(() => handler(Buffer.from(JSON.stringify(body))));
                        if (event === 'end') process.nextTick(handler);
                    },
                };
                callback(response);
            });
            return request;
        });

        const result = await updateService.checkPrebuiltAvailable(remoteSHA);
        expect(result).toMatchObject({
            available: true,
            exact: true,
            source: 'github-actions',
            artifactId: 67890,
            runId,
            commit: remoteSHA,
        });
    });
});
