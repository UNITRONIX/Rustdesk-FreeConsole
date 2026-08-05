'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const yauzl = require('yauzl');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const config = require('../config/config');
const RealClientBuildProvider = require('./realClientBuildProvider');
const configService = require('./realClientConfigService');
const payloadService = require('./realClientPayloadService');

const TERMINAL_FAILURES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const RUN_DISCOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const RUN_DISCOVERY_MAX_PAGES = 5;
const MAX_ARTIFACT_ARCHIVE_ENTRIES = 2048;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const SAFE_DISPATCH_REF = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|[\\~^:?*\[\x00-\x20]))(?!.*[\/.]$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// Must match docs/real-client-build-repository/build-real-client.mjs. The
// environment matrix is an E2E allow-list inside this executable adapter
// contract, not a way to turn a prospective/legacy target into support.
const CENTRAL_ADAPTER_REVISIONS = new Map([
    ['1.4.9', '6c578292e8ebbbec708b76986ba8c4bc7c509747'],
]);
const CENTRAL_ADAPTER_TARGETS = new Set(configService.TARGETS
    .map((target) => target.id)
    .filter((id) => id !== 'windows-x86-exe'));

function safeGithubMessage(error) {
    const status = error && error.response && error.response.status;
    const raw = error && error.response && error.response.data && error.response.data.message;
    const message = String(raw || (error && error.message) || 'GitHub request failed')
        .replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[masked]')
        .slice(0, 500);
    return status ? `GitHub API ${status}: ${message}` : message;
}

function openZip(filePath) {
    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => error ? reject(error) : resolve(zip));
    });
}

function openEntry(zip, entry) {
    return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

class GithubRealClientBuildProvider extends RealClientBuildProvider {
    constructor() {
        super('github');
        this.settings = config.realClient;
        this.client = axios.create({
            baseURL: String(this.settings.githubApiUrl || 'https://api.github.com').replace(/\/+$/, ''),
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': `BetterDesk/${config.appVersion}`,
                ...(this.settings.githubToken ? { Authorization: `Bearer ${this.settings.githubToken}` } : {}),
            },
        });
    }

    workflowFor(target) {
        const configured = this.settings.githubWorkflows[target.id]
            || this.settings.githubWorkflows[target.platform]
            || null;
        if (configured == null) return null;
        const workflow = String(configured).trim();
        return /^(?:\d{1,20}|[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml)$/i.test(workflow)
            ? workflow
            : null;
    }

    sourceCommitFor(version) {
        const commit = String(this.settings.sourceRevisions?.[version] || '').trim();
        return GIT_COMMIT.test(commit) ? commit.toLowerCase() : null;
    }

    workflowCommit() {
        const commit = String(this.settings.githubWorkflowCommit || '').trim();
        return GIT_COMMIT.test(commit) ? commit.toLowerCase() : null;
    }

    capabilities() {
        const missing = [];
        if (!this.settings.githubToken) missing.push('REAL_CLIENT_GITHUB_TOKEN');
        if (!this.settings.githubOwner) missing.push('REAL_CLIENT_GITHUB_OWNER');
        if (!this.settings.githubRepo) missing.push('REAL_CLIENT_GITHUB_REPO');
        if (!SAFE_DISPATCH_REF.test(String(this.settings.githubRef || ''))) missing.push('valid REAL_CLIENT_GITHUB_REF branch or tag');
        if (!this.workflowCommit()) missing.push('40-character REAL_CLIENT_GITHUB_WORKFLOW_COMMIT');
        try {
            const apiUrl = new URL(this.settings.githubApiUrl);
            if (apiUrl.protocol !== 'https:' || !apiUrl.hostname || apiUrl.username || apiUrl.password
                || apiUrl.search || apiUrl.hash) throw new Error('invalid GitHub API URL');
        } catch (_) {
            missing.push('HTTPS REAL_CLIENT_GITHUB_API_URL without credentials');
        }
        if (!this.settings.publicBaseUrl) missing.push('REAL_CLIENT_PUBLIC_BASE_URL');
        let publicBaseUrl = null;
        if (this.settings.publicBaseUrl) {
            try {
                publicBaseUrl = new URL(this.settings.publicBaseUrl);
                if (publicBaseUrl.protocol !== 'https:' || publicBaseUrl.username
                    || publicBaseUrl.password || publicBaseUrl.pathname !== '/' || publicBaseUrl.search || publicBaseUrl.hash) {
                    throw new Error('invalid public origin');
                }
            } catch (_) {
                missing.push('valid origin-only REAL_CLIENT_PUBLIC_BASE_URL');
            }
        }
        if (!payloadService.configured()) missing.push('valid RSA-3072+ REAL_CLIENT_PAYLOAD_PUBLIC_KEY');
        const knownTargets = new Set(configService.TARGETS.map((target) => target.id));
        const combinations = [];
        const versions = [];
        for (const [targetId, rawVersions] of Object.entries(this.settings.verifiedMatrix || {})) {
            if (!knownTargets.has(targetId)) {
                missing.push(`recognized REAL_CLIENT_GITHUB_MATRIX target: ${targetId}`);
                continue;
            }
            if (!CENTRAL_ADAPTER_TARGETS.has(targetId)) {
                missing.push(`target supported by the bundled central adapter: ${targetId}`);
                continue;
            }
            if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
                missing.push(`non-empty REAL_CLIENT_GITHUB_MATRIX versions for: ${targetId}`);
                continue;
            }
            for (const version of rawVersions) {
                const validation = configService.normalizeRustDeskVersion(version);
                if (!validation.valid) {
                    missing.push(`valid REAL_CLIENT_GITHUB_MATRIX version for ${targetId}: ${version}`);
                    continue;
                }
                if (!CENTRAL_ADAPTER_REVISIONS.has(validation.value)) {
                    missing.push(`version supported by the bundled central adapter for ${targetId}: ${validation.value}`);
                    continue;
                }
                const sourceCommit = this.sourceCommitFor(validation.value);
                if (!sourceCommit) {
                    missing.push(`40-character REAL_CLIENT_GITHUB_REVISIONS commit for ${validation.value}`);
                    continue;
                }
                if (sourceCommit !== CENTRAL_ADAPTER_REVISIONS.get(validation.value)) {
                    missing.push(`approved bundled adapter commit for ${validation.value}`);
                    continue;
                }
                const combination = `${targetId}@${validation.value}`;
                if (!combinations.includes(combination)) combinations.push(combination);
                if (!versions.includes(validation.value)) versions.push(validation.value);
            }
        }
        if (!combinations.length) missing.push('REAL_CLIENT_GITHUB_MATRIX');
        const enabledTargetIds = new Set(combinations.map((item) => item.slice(0, item.indexOf('@'))));
        const enabledTargets = configService.TARGETS
            .filter((target) => enabledTargetIds.has(target.id));
        const missingWorkflows = enabledTargets
            .filter((target) => !this.workflowFor(target))
            .map((target) => target.id);
        if (missingWorkflows.length) {
            missing.push(`REAL_CLIENT_GITHUB_WORKFLOWS mappings for: ${missingWorkflows.join(', ')}`);
        }
        const targets = enabledTargets.filter((target) => !!this.workflowFor(target));
        return {
            id: this.id,
            label: 'GitHub Actions',
            enabled: missing.length === 0 && targets.length > 0,
            reason: missing.length ? `Missing configuration: ${missing.join(', ')}` : '',
            targets,
            versions,
            combinations,
        };
    }

    repoPath(suffix) {
        const owner = encodeURIComponent(this.settings.githubOwner);
        const repo = encodeURIComponent(this.settings.githubRepo);
        return `/repos/${owner}/${repo}${suffix}`;
    }

    async dispatch({ build, target, payloadUrl }) {
        if (!CENTRAL_ADAPTER_TARGETS.has(target.id)) throw new Error(`Target ${target.id} is not implemented by the bundled central adapter`);
        const approvedSourceCommit = CENTRAL_ADAPTER_REVISIONS.get(build.rustdesk_version);
        if (!approvedSourceCommit) throw new Error(`RustDesk ${build.rustdesk_version} is not implemented by the bundled central adapter`);
        const workflow = this.workflowFor(target);
        if (!workflow) throw new Error(`No GitHub workflow is configured for ${target.id}`);
        const sourceCommit = this.sourceCommitFor(build.rustdesk_version);
        if (!sourceCommit || sourceCommit !== approvedSourceCommit || build.source_commit !== sourceCommit) {
            throw new Error('Build source commit does not match the configured immutable revision');
        }
        const workflowCommit = this.workflowCommit();
        if (!workflowCommit) throw new Error('Central build workflow commit is not pinned');
        const expectedPayloadUrl = new URL(`/api/generator/real-client/payload/${build.id}`, `${this.settings.publicBaseUrl}/`).toString();
        if (payloadUrl !== expectedPayloadUrl) throw new Error('Encrypted payload URL does not match the configured trusted origin and build ID');
        try {
            const response = await this.client.post(this.repoPath(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`), {
                ref: this.settings.githubRef,
                inputs: {
                    build_id: build.id,
                    payload_url: payloadUrl,
                    target: target.id,
                    rustdesk_version: build.rustdesk_version,
                    source_commit: sourceCommit,
                    workflow_commit: workflowCommit,
                    artifact_retention_days: String(this.settings.artifactRetentionDays),
                },
            });
            const body = response.data && typeof response.data === 'object' ? response.data : {};
            const runId = body.workflow_run_id || body.id || null;
            return {
                status: 'dispatching',
                providerRunId: runId ? String(runId) : null,
                providerRunUrl: body.html_url || null,
                providerStatus: 'dispatched',
                logSummary: 'Build request accepted by GitHub Actions.',
            };
        } catch (error) {
            throw new Error(safeGithubMessage(error));
        }
    }

    async findRun(build) {
        const target = configService.targetById(buildTargetId(build));
        if (!target) return null;
        const workflow = this.workflowFor(target);
        if (!workflow) return null;
        const workflowCommit = this.workflowCommit();
        if (!workflowCommit) return null;
        try {
            const queuedAt = new Date(build.queued_at || build.created_at || 0).getTime() - 5 * 60 * 1000;
            for (let page = 1; page <= RUN_DISCOVERY_MAX_PAGES; page += 1) {
                const response = await this.client.get(this.repoPath(`/actions/workflows/${encodeURIComponent(workflow)}/runs`), {
                    // Do not use GitHub's `branch` filter here: dispatch accepts
                    // a branch or tag, while that listing filter does not
                    // reliably correlate tag-dispatched runs. The workflow,
                    // UUID and bounded creation time provide exact matching.
                    params: { event: 'workflow_dispatch', per_page: 100, page },
                });
                const runs = response.data.workflow_runs || [];
                const match = runs.find((run) => {
                    const title = `${run.display_title || ''} ${run.name || ''}`;
                    return String(run.head_sha || '').toLowerCase() === workflowCommit
                        && title.includes(build.id)
                        && new Date(run.created_at).getTime() >= queuedAt;
                });
                if (match) return match;
                if (runs.length < 100 || runs.some((run) => new Date(run.created_at).getTime() < queuedAt)) break;
            }
            return null;
        } catch (error) {
            throw new Error(safeGithubMessage(error));
        }
    }

    async jobSummary(runId) {
        try {
            const response = await this.client.get(this.repoPath(`/actions/runs/${encodeURIComponent(runId)}/jobs`), {
                params: { per_page: 100 },
            });
            const lines = [];
            for (const job of response.data.jobs || []) {
                const jobState = job.conclusion || job.status || 'unknown';
                lines.push(`${job.name}: ${jobState}`);
                for (const step of job.steps || []) {
                    if (step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped') {
                        lines.push(`  ${step.name}: ${step.conclusion}`);
                    }
                }
            }
            return lines.join('\n').slice(0, 12000);
        } catch (_) {
            return '';
        }
    }

    async inspect(build) {
        let run = null;
        try {
            if (build.provider_run_id) {
                const response = await this.client.get(this.repoPath(`/actions/runs/${encodeURIComponent(build.provider_run_id)}`));
                run = response.data;
            } else {
                run = await this.findRun(build);
            }
        } catch (error) {
            throw new Error(safeGithubMessage(error));
        }

        if (!run) {
            const age = Date.now() - new Date(build.queued_at || build.created_at).getTime();
            if (age > RUN_DISCOVERY_TIMEOUT_MS) {
                if (build.status === 'cancelling') {
                    return {
                        status: 'cancelled',
                        providerStatus: 'run_not_found_after_cancel',
                        cancelledAt: new Date().toISOString(),
                        logSummary: 'Cancellation completed; no matching GitHub Actions run appeared within 30 minutes.',
                    };
                }
                return { status: 'failed', errorMessage: 'GitHub Actions run was not found within 30 minutes.' };
            }
            return build.status === 'cancelling'
                ? { status: 'cancelling', providerStatus: 'waiting_to_cancel', logSummary: 'Waiting for the GitHub Actions run before cancelling it.' }
                : { status: 'dispatching', providerStatus: 'waiting_for_run', logSummary: 'Waiting for GitHub Actions run.' };
        }

        const common = {
            providerRunId: String(run.id),
            providerRunUrl: run.html_url || null,
            providerStatus: run.conclusion || run.status || 'unknown',
        };
        if (build.status === 'cancelling' && run.status !== 'completed') {
            try {
                await this.requestCancellation(run.id);
                return {
                    ...common,
                    status: 'cancelling',
                    providerStatus: 'cancel_requested',
                    logSummary: 'Cancellation requested from GitHub Actions.',
                };
            } catch (error) {
                if (error.response && error.response.status === 409) {
                    // The run crossed into a terminal state after this poll's
                    // snapshot. Keep the local cancellation intent and fetch
                    // the authoritative conclusion on the next poll.
                    return {
                        ...common,
                        status: 'cancelling',
                        providerStatus: 'waiting_for_terminal_state',
                        logSummary: 'The GitHub run changed state while cancellation was requested; waiting for its terminal conclusion.',
                    };
                }
                throw new Error(safeGithubMessage(error));
            }
        }
        if (run.status !== 'completed') {
            return {
                ...common,
                status: run.status === 'in_progress' ? 'building' : 'queued',
                startedAt: run.run_started_at || null,
                logSummary: await this.jobSummary(run.id),
            };
        }

        if (run.conclusion === 'cancelled') {
            return { ...common, status: 'cancelled', cancelledAt: run.updated_at || new Date().toISOString(), finishedAt: run.updated_at || null, logSummary: await this.jobSummary(run.id) };
        }
        if (TERMINAL_FAILURES.has(run.conclusion) || run.conclusion !== 'success') {
            return {
                ...common,
                status: 'failed',
                finishedAt: run.updated_at || new Date().toISOString(),
                errorMessage: `GitHub Actions completed with conclusion: ${run.conclusion || 'unknown'}`,
                logSummary: await this.jobSummary(run.id),
            };
        }

        const artifact = build.artifact_path ? null : await this.downloadArtifact(build, run.id);
        if (!build.artifact_path && !artifact) {
            const finishedAge = Date.now() - new Date(run.updated_at || 0).getTime();
            if (finishedAge < 5 * 60 * 1000) {
                return { ...common, status: 'building', logSummary: 'Build succeeded; waiting for the matching artifact.' };
            }
            return { ...common, status: 'failed', finishedAt: run.updated_at || null, errorMessage: 'Build succeeded but no matching artifact was published.' };
        }
        return {
            ...common,
            status: 'ready',
            finishedAt: run.updated_at || new Date().toISOString(),
            logSummary: await this.jobSummary(run.id),
            ...(artifact || {}),
        };
    }

    async downloadArtifact(build, runId) {
        let artifacts;
        try {
            const response = await this.client.get(this.repoPath(`/actions/runs/${encodeURIComponent(runId)}/artifacts`), { params: { per_page: 100 } });
            artifacts = response.data.artifacts || [];
        } catch (error) {
            throw new Error(safeGithubMessage(error));
        }
        const expected = `real-client-${build.id}`;
        const artifact = artifacts.find((item) => !item.expired && item.name === expected);
        if (!artifact) return null;

        const artifactRoot = path.resolve(config.dataDir, 'real-client-artifacts', build.id);
        const zipPath = path.join(artifactRoot, '.github-artifact.zip');
        // A previous process may have downloaded/extracted the file but failed
        // before committing metadata. Rebuild the private directory from the
        // authoritative GitHub artifact to keep retries idempotent.
        await fs.promises.rm(artifactRoot, { recursive: true, force: true });
        await fs.promises.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
        try {
            const response = await this.client.get(this.repoPath(`/actions/artifacts/${encodeURIComponent(artifact.id)}/zip`), {
                responseType: 'stream', timeout: 10 * 60 * 1000,
            });
            const maxArchive = this.settings.maxArtifactBytes + 32 * 1024 * 1024;
            let written = 0;
            const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                    written += chunk.length;
                    if (written > maxArchive) return callback(new Error('GitHub artifact archive exceeds configured size limit'));
                    callback(null, chunk);
                },
            });
            await pipeline(response.data, limiter, fs.createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }));
            return await this.extractExpectedArtifact(zipPath, artifactRoot, build);
        } catch (error) {
            // Never retain a partial archive or extracted executable after a
            // failed download/validation. A later poll can retry from GitHub.
            await fs.promises.rm(artifactRoot, { recursive: true, force: true }).catch(() => {});
            throw new Error(safeGithubMessage(error));
        } finally {
            await fs.promises.rm(zipPath, { force: true }).catch(() => {});
        }
    }

    async extractExpectedArtifact(zipPath, artifactRoot, build) {
        const zip = await openZip(zipPath);
        if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 1
            || zip.entryCount > MAX_ARTIFACT_ARCHIVE_ENTRIES) {
            zip.close();
            throw new Error(`GitHub artifact archive entry count must be between 1 and ${MAX_ARTIFACT_ARCHIVE_ENTRIES}`);
        }
        const candidates = [];
        const expectedExt = `.${String(build.package_type || '').toLowerCase()}`;
        const snapshot = (() => { try { return JSON.parse(build.config_snapshot_json || '{}'); } catch (_) { return {}; } })();
        const expectedStem = String(snapshot.executableName || '').toLowerCase();
        await new Promise((resolve, reject) => {
            zip.on('entry', (entry) => {
                const name = String(entry.fileName || '');
                const base = path.posix.basename(name);
                const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
                const symlink = (mode & 0o170000) === 0o120000;
                const lowerBase = base.toLowerCase();
                const stem = lowerBase.slice(0, -expectedExt.length);
                const expectedName = !expectedStem || stem === expectedStem
                    || stem.startsWith(`${expectedStem}-`) || stem.startsWith(`${expectedStem}_`);
                if (!name.endsWith('/') && name === base && !name.includes('\\') && !symlink
                    && lowerBase.endsWith(expectedExt) && expectedName && entry.uncompressedSize > 0) {
                    candidates.push(entry);
                }
                zip.readEntry();
            });
            zip.once('error', reject);
            zip.once('end', resolve);
            zip.readEntry();
        });
        if (candidates.length !== 1) {
            throw new Error(`Expected exactly one ${expectedExt} file in the build artifact; found ${candidates.length}`);
        }
        const entry = candidates[0];
        if (entry.uncompressedSize > this.settings.maxArtifactBytes) throw new Error('Build artifact exceeds configured size limit');

        // Re-open because yauzl closes after the first lazy enumeration.
        const extractionZip = await openZip(zipPath);
        const selected = await new Promise((resolve, reject) => {
            extractionZip.on('entry', (item) => {
                if (item.fileName === entry.fileName) return resolve(item);
                extractionZip.readEntry();
            });
            extractionZip.once('error', reject);
            extractionZip.once('end', () => reject(new Error('Selected artifact disappeared from ZIP')));
            extractionZip.readEntry();
        });
        const safeName = path.posix.basename(selected.fileName).replace(/[^A-Za-z0-9._-]/g, '_');
        const destination = path.join(artifactRoot, safeName);
        const temp = `${destination}.partial`;
        const hash = crypto.createHash('sha256');
        const maxArtifactBytes = this.settings.maxArtifactBytes;
        let size = 0;
        const hasher = new Transform({
            transform(chunk, _encoding, callback) {
                size += chunk.length;
                if (size > maxArtifactBytes) return callback(new Error('Extracted artifact exceeds configured size limit'));
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        const stream = await openEntry(extractionZip, selected);
        try {
            await pipeline(stream, hasher, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            await fs.promises.rename(temp, destination);
        } catch (error) {
            await fs.promises.rm(temp, { force: true }).catch(() => {});
            throw error;
        } finally {
            extractionZip.close();
        }
        return {
            artifactName: safeName,
            artifactPath: destination,
            artifactSize: size,
            artifactSha256: hash.digest('hex'),
        };
    }

    async cancel(build) {
        let runId = build.provider_run_id;
        let run = null;
        if (!runId) {
            run = await this.findRun(build);
            if (!run) {
                return {
                    status: 'cancelling',
                    providerStatus: 'waiting_to_cancel',
                    logSummary: 'Cancellation requested; waiting for the matching GitHub Actions run.',
                };
            }
            runId = String(run.id);
        }
        try {
            await this.requestCancellation(runId);
            return {
                status: 'cancelling',
                providerRunId: String(runId),
                providerRunUrl: run && run.html_url || build.provider_run_url || null,
                providerStatus: 'cancel_requested',
                logSummary: 'Cancellation requested from GitHub Actions.',
            };
        } catch (error) {
            if (error.response && error.response.status === 409) {
                return this.inspect({ ...build, provider_run_id: String(runId) });
            }
            throw new Error(safeGithubMessage(error));
        }
    }

    async requestCancellation(runId) {
        return this.client.post(this.repoPath(`/actions/runs/${encodeURIComponent(runId)}/cancel`));
    }
}

function buildTargetId(build) {
    const match = configService.TARGETS.find((target) => target.platform === build.platform
        && target.arch === build.arch && target.package === build.package_type);
    return match ? match.id : '';
}

module.exports = GithubRealClientBuildProvider;
