'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/config');
const db = require('./database');
const configService = require('./realClientConfigService');
const assetService = require('./realClientAssetService');
const payloadService = require('./realClientPayloadService');
const GithubRealClientBuildProvider = require('./githubRealClientBuildProvider');

const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'expired']);
const PROVIDER_SYNC_FAILURE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_BATCH_BUILDS = 30;
const BATCH_DISPATCH_CONCURRENCY = 4;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function maskText(value) {
    return String(value || '')
        .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[masked private key]')
        .replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[masked]')
        .replace(/(["']?(?:password|token|secret|private[_ -]?key)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2/gi, '$1"[masked]"')
        .replace(/(password|token|secret|private[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[masked]')
        .slice(0, 12000);
}

function safeExternalUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch (_) {
        return null;
    }
}

function validateOneTimeSecrets(value = {}) {
    const rawPassword = value && value.permanentPassword;
    if (rawPassword == null || rawPassword === '') return { valid: true, secrets: {} };
    if (typeof rawPassword !== 'string' || rawPassword.length > 256
        || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(rawPassword)) {
        return {
            valid: false,
            secrets: {},
            error: { field: 'permanent_password', code: 'invalid_secret', message: 'Permanent password contains unsupported characters or exceeds 256 characters' },
        };
    }
    return { valid: true, secrets: { permanentPassword: rawPassword } };
}

async function mapWithConcurrency(items, concurrency, operation) {
    const output = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            output[index] = await operation(items[index], index);
        }
    });
    await Promise.all(workers);
    return output;
}

function serializeConfig(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        owner_user_id: row.owner_user_id || null,
        organization_id: row.organization_id || null,
        config: parseJson(row.config_json, configService.defaultConfig()),
        assets: parseJson(row.assets_json, {}),
        target: {
            platform: row.target_platform || null,
            arch: row.target_arch || null,
            package: row.target_package || null,
        },
        build_provider: row.build_provider || 'github',
        rustdesk_version: row.rustdesk_version || null,
        last_build: row.last_build_id ? {
            id: row.last_build_id,
            platform: row.last_platform,
            arch: row.last_arch,
            package: row.last_package,
            provider: row.last_provider,
            version: row.last_version,
            status: row.last_status,
        } : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function serializeBuild(row) {
    if (!row) return null;
    return {
        id: row.id,
        config_id: row.config_id || null,
        config_name: row.config_name || '',
        requested_by: row.requested_by || null,
        owner_user_id: row.owner_user_id || null,
        organization_id: row.organization_id || null,
        batch_id: row.batch_id || null,
        client_variant: row.client_variant || 'client',
        platform: row.platform,
        arch: row.arch,
        package: row.package_type,
        provider: row.provider,
        rustdesk_version: row.rustdesk_version,
        source_commit: row.source_commit || null,
        status: row.status,
        provider_run_id: row.provider_run_id || null,
        provider_run_url: safeExternalUrl(row.provider_run_url),
        provider_status: row.provider_status || null,
        artifact: row.artifact_path ? {
            name: row.artifact_name,
            size: Number(row.artifact_size || 0),
            sha256: row.artifact_sha256,
            download_url: `/api/generator/real-client/builds/${row.id}/download`,
        } : null,
        log_summary: maskText(row.log_summary),
        error_message: maskText(row.error_message),
        queued_at: row.queued_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        cancelled_at: row.cancelled_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

class RealClientBuildService {
    constructor() {
        this.providers = new Map();
        const github = new GithubRealClientBuildProvider();
        this.providers.set(github.id, github);
        this.buildLocks = new Map();
        this.timer = null;
        this.syncing = false;
    }

    capabilities() {
        const providers = [...this.providers.values()].map((provider) => provider.capabilities());
        const targetProviders = new Map();
        const verifiedVersions = new Set();
        const verifiedCombinations = new Set();
        for (const provider of providers) {
            if (!provider.enabled) continue;
            for (const target of provider.targets) {
                if (!targetProviders.has(target.id)) targetProviders.set(target.id, []);
                targetProviders.get(target.id).push(provider.id);
            }
            for (const version of provider.versions || []) verifiedVersions.add(version);
            for (const combination of provider.combinations || []) verifiedCombinations.add(combination);
        }
        const targets = configService.TARGETS.map((target) => ({
            ...target,
            enabled: targetProviders.has(target.id),
            providers: targetProviders.get(target.id) || [],
        }));
        return {
            providers: providers.map((provider) => ({
                id: provider.id,
                label: provider.label,
                enabled: provider.enabled,
                reason: provider.reason,
            })),
            targets,
            versions: [...verifiedVersions].sort(),
            combinations: [...verifiedCombinations].sort(),
            variants: configService.CLIENT_VARIANTS,
            local_provider: {
                enabled: false,
                reason: 'Not registered: cross-platform RustDesk toolchains are not reproducible or isolated on the BetterDesk application host.',
            },
        };
    }

    availableTargetIds(providerId = null) {
        const ids = new Set();
        for (const provider of this.providers.values()) {
            const capability = provider.capabilities();
            if (!capability.enabled || (providerId && provider.id !== providerId)) continue;
            for (const target of capability.targets) ids.add(target.id);
        }
        return ids;
    }

    availableRustDeskVersions(providerId = null) {
        const versions = new Set();
        for (const provider of this.providers.values()) {
            const capability = provider.capabilities();
            if (!capability.enabled || (providerId && provider.id !== providerId)) continue;
            for (const version of capability.versions || []) versions.add(version);
        }
        return versions;
    }

    availableBuildCombinations(providerId = null) {
        const combinations = new Set();
        for (const provider of this.providers.values()) {
            const capability = provider.capabilities();
            if (!capability.enabled || (providerId && provider.id !== providerId)) continue;
            for (const combination of capability.combinations || []) combinations.add(combination);
        }
        return combinations;
    }

    async listConfigs() {
        return (await db.listRealClientConfigs()).map(serializeConfig);
    }

    async getConfig(id) {
        return serializeConfig(await db.getRealClientConfig(id));
    }

    validateConfig(body, options = {}) {
        const rawName = String(body && body.name || '').trim();
        const rawDescription = String(body && body.description || '').trim();
        const name = rawName.slice(0, 120);
        const description = rawDescription.slice(0, 1000);
        const organizationProvided = !!body && Object.prototype.hasOwnProperty.call(body, 'organization_id');
        const organizationRaw = String(body && body.organization_id || '').trim();
        const organizationId = organizationRaw && /^\d{1,18}$/.test(organizationRaw) ? organizationRaw : null;
        const validation = configService.normalizeConfig(body && body.config || {});
        if (!name) validation.errors.unshift({ field: 'name', code: 'required', message: 'Configuration name is required' });
        if (rawName.length > 120) validation.errors.push({ field: 'name', code: 'too_long', message: 'Configuration name may contain at most 120 characters' });
        if (rawDescription.length > 1000) validation.errors.push({ field: 'description', code: 'too_long', message: 'Description may contain at most 1000 characters' });
        if (organizationRaw && !organizationId) validation.errors.push({ field: 'organization_id', code: 'invalid', message: 'Organization ID is invalid' });
        validation.valid = validation.errors.length === 0;
        return {
            ...validation, name, description,
            organizationId: organizationProvided ? organizationId : (options.organizationId || null),
        };
    }

    async validateOrganization(result) {
        if (!result.valid || !result.organizationId) return result;
        const tenant = await db.getTenantById(result.organizationId);
        if (!tenant) {
            result.errors.push({ field: 'organization_id', code: 'not_found', message: 'Organization does not exist' });
            result.valid = false;
        }
        return result;
    }

    async validateAssets(result, ownerUserId) {
        if (!result.valid) return result;
        for (const kind of ['icon', 'logo', 'privacy']) {
            const id = result.normalized.assets && result.normalized.assets[kind];
            if (!id) continue;
            try {
                await assetService.readAsset({ ownerUserId, id, kind });
            } catch (_) {
                result.errors.push({
                    field: `assets.${kind}`,
                    code: 'asset_not_found',
                    message: `The selected ${kind} asset is missing, corrupt or belongs to another owner`,
                });
                result.valid = false;
            }
        }
        return result;
    }

    async createConfig(body, ownerUserId) {
        let result = await this.validateOrganization(this.validateConfig(body));
        result = await this.validateAssets(result, ownerUserId);
        if (!result.valid) return result;
        const row = await db.createRealClientConfig({
            id: configService.generateId(),
            name: result.name,
            description: result.description,
            ownerUserId,
            organizationId: result.organizationId,
            configJson: JSON.stringify(result.normalized),
            assetsJson: JSON.stringify(result.normalized.assets || {}),
            targetPlatform: result.target && result.target.platform,
            targetArch: result.target && result.target.arch,
            targetPackage: result.target && result.target.package,
            buildProvider: 'github',
            rustdeskVersion: result.normalized.rustdeskVersion,
        });
        return { ...result, data: serializeConfig(row) };
    }

    async updateConfig(id, body) {
        const existing = await db.getRealClientConfig(id);
        if (!existing) return { valid: false, notFound: true, errors: [{ field: 'id', code: 'not_found', message: 'Configuration not found' }] };
        let result = await this.validateOrganization(this.validateConfig(body, { organizationId: existing.organization_id }));
        result = await this.validateAssets(result, existing.owner_user_id);
        if (!result.valid) return result;
        const row = await db.updateRealClientConfig(id, {
            name: result.name,
            description: result.description,
            organizationId: result.organizationId,
            configJson: JSON.stringify(result.normalized),
            assetsJson: JSON.stringify(result.normalized.assets || {}),
            targetPlatform: result.target && result.target.platform,
            targetArch: result.target && result.target.arch,
            targetPackage: result.target && result.target.package,
            buildProvider: existing.build_provider || 'github',
            rustdeskVersion: result.normalized.rustdeskVersion,
        });
        return { ...result, data: serializeConfig(row) };
    }

    async duplicateConfig(id, ownerUserId) {
        const source = await db.getRealClientConfig(id);
        if (!source) return null;
        const duplicatedConfig = parseJson(source.config_json, configService.defaultConfig());
        if (source.owner_user_id && source.owner_user_id !== ownerUserId) {
            for (const kind of ['icon', 'logo', 'privacy']) {
                const assetId = duplicatedConfig.assets && duplicatedConfig.assets[kind];
                if (!assetId) continue;
                const asset = await assetService.readAsset({ ownerUserId: source.owner_user_id, id: assetId, kind });
                const copy = await assetService.saveAsset({ ownerUserId, kind, buffer: asset.buffer, originalName: `${kind}.png` });
                duplicatedConfig.assets[kind] = copy.id;
            }
        }
        const row = await db.createRealClientConfig({
            id: configService.generateId(),
            name: `${source.name} (copy)`.slice(0, 120),
            description: source.description || '',
            ownerUserId,
            organizationId: source.organization_id,
            configJson: JSON.stringify(duplicatedConfig),
            assetsJson: JSON.stringify(duplicatedConfig.assets || {}),
            targetPlatform: source.target_platform,
            targetArch: source.target_arch,
            targetPackage: source.target_package,
            buildProvider: source.build_provider || 'github',
            rustdeskVersion: source.rustdesk_version,
        });
        return serializeConfig(row);
    }

    async deleteConfig(id) {
        return db.deleteRealClientConfig(id);
    }

    async listBuilds(options = {}) {
        return (await db.listRealClientBuilds(options)).map(serializeBuild);
    }

    async getBuild(id) {
        return serializeBuild(await db.getRealClientBuild(id));
    }

    validateBuildConfiguration(rawConfig, providerId, targetId, clientVariant = 'client', oneTimeSecrets = {}) {
        let derived;
        try {
            derived = configService.deriveConfigForBuild(rawConfig, { targetId, variantId: clientVariant });
        } catch (error) {
            return {
                valid: false,
                errors: [{ field: 'build_selection', code: 'invalid_selection', message: error.message }],
                warnings: [],
            };
        }
        const validation = configService.normalizeConfig(derived.config, {
            availableTargetIds: this.availableTargetIds(providerId),
            availableRustDeskVersions: this.availableRustDeskVersions(providerId),
            availableBuildCombinations: this.availableBuildCombinations(providerId),
        });
        validation.warnings.push(...derived.adjustments.map((item) => ({
            field: 'client_variant',
            ...item,
        })));
        if (validation.normalized.hideConnectionManager && !oneTimeSecrets.permanentPassword) {
            validation.errors.push({
                field: 'permanent_password',
                code: 'required',
                message: 'A permanent password is required when Hide connection manager is enabled',
            });
            validation.valid = false;
        }
        return { ...validation, variant: derived.variant };
    }

    async planBuildMatrix({ configId, providerId = 'github' }) {
        const configRow = await db.getRealClientConfig(configId);
        if (!configRow) return null;
        const provider = this.providers.get(providerId);
        const capability = provider && provider.capabilities();
        const rawConfig = parseJson(configRow.config_json, {});
        const entries = [];
        for (const variant of configService.CLIENT_VARIANTS) {
            for (const target of configService.TARGETS) {
                // A plan does not require the password to be submitted. The UI
                // surfaces that requirement before dispatching the batch.
                const derived = configService.deriveConfigForBuild(rawConfig, {
                    targetId: target.id,
                    variantId: variant.id,
                });
                const validation = configService.normalizeConfig(derived.config, {
                    availableTargetIds: this.availableTargetIds(providerId),
                    availableRustDeskVersions: this.availableRustDeskVersions(providerId),
                    availableBuildCombinations: this.availableBuildCombinations(providerId),
                });
                entries.push({
                    target: target.id,
                    variant: variant.id,
                    enabled: !!(capability && capability.enabled && validation.valid),
                    requires_password: !!validation.normalized.hideConnectionManager,
                    errors: validation.errors,
                    warnings: validation.warnings,
                    adjustments: derived.adjustments,
                });
            }
        }
        return {
            config_id: configRow.id,
            provider: providerId,
            provider_enabled: !!(capability && capability.enabled),
            source_commit: provider && typeof provider.sourceCommitFor === 'function'
                ? provider.sourceCommitFor(rawConfig.rustdeskVersion)
                : null,
            entries,
        };
    }

    normalizeBatchSelection(targetIds, clientVariants) {
        // Batch requests are intentionally explicit. Falling back to the saved
        // default target after the user pressed "Clear" would dispatch a build
        // they did not select. The single-build endpoint remains available for
        // callers that want the saved default target.
        const rawTargets = Array.isArray(targetIds) ? targetIds : [];
        const rawVariants = Array.isArray(clientVariants) ? clientVariants : [];
        const targets = [...new Set(rawTargets.map((value) => String(value || '').trim()).filter(Boolean))];
        const variants = [...new Set(rawVariants.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
        const errors = [];
        for (const target of targets) {
            if (!configService.targetById(target)) errors.push({ field: 'targets', code: 'unsupported_target', message: `Unknown build target: ${target}` });
        }
        for (const variant of variants) {
            if (!configService.buildVariantById(variant)) errors.push({ field: 'variants', code: 'unsupported_variant', message: `Unknown client variant: ${variant}` });
        }
        const count = targets.length * variants.length;
        if (!targets.length) errors.push({ field: 'targets', code: 'required', message: 'Select at least one build target' });
        if (!variants.length) errors.push({ field: 'variants', code: 'required', message: 'Select at least one client variant' });
        if (count > MAX_BATCH_BUILDS) {
            errors.push({ field: 'targets', code: 'batch_too_large', message: `A single request may contain at most ${MAX_BATCH_BUILDS} builds` });
        }
        return { valid: errors.length === 0, errors, targets, variants, count };
    }

    async createBuild({
        configId,
        providerId = 'github',
        oneTimeSecrets = {},
        targetId = null,
        clientVariant = 'client',
        batchId = null,
        setAsLastBuild = true,
    }, requestedBy) {
        const configRow = await db.getRealClientConfig(configId);
        if (!configRow) return { ok: false, statusCode: 404, errors: [{ field: 'configId', message: 'Configuration not found' }] };
        const secretValidation = validateOneTimeSecrets(oneTimeSecrets);
        if (!secretValidation.valid) return { ok: false, statusCode: 400, errors: [secretValidation.error] };
        const provider = this.providers.get(providerId);
        if (!provider) return { ok: false, statusCode: 400, errors: [{ field: 'provider', message: 'Unknown build provider' }] };
        const capability = provider.capabilities();
        if (!capability.enabled) return { ok: false, statusCode: 503, errors: [{ field: 'provider', message: capability.reason || 'Build provider is unavailable' }] };

        const rawConfig = parseJson(configRow.config_json, {});
        const selectedTarget = targetId || rawConfig.target;
        const validation = this.validateBuildConfiguration(
            rawConfig,
            providerId,
            selectedTarget,
            clientVariant,
            secretValidation.secrets,
        );
        if (!validation.valid) return { ok: false, statusCode: 400, errors: validation.errors, warnings: validation.warnings };
        const target = validation.target;
        const sourceCommit = typeof provider.sourceCommitFor === 'function'
            ? provider.sourceCommitFor(validation.normalized.rustdeskVersion)
            : null;
        if (!/^[0-9a-f]{40}$/i.test(String(sourceCommit || ''))) {
            return {
                ok: false,
                statusCode: 503,
                errors: [{
                    field: 'rustdesk_version',
                    code: 'immutable_revision_missing',
                    message: 'The selected provider has no immutable source commit for this RustDesk version',
                }],
                warnings: validation.warnings,
            };
        }
        const buildId = configService.generateId();
        return this.withBuildLock(buildId, async () => {
            const buildRow = await db.createRealClientBuild({
                id: buildId,
                configId: configRow.id,
                configName: configRow.name,
                configSnapshotJson: JSON.stringify(validation.normalized),
                requestedBy,
                ownerUserId: configRow.owner_user_id || requestedBy,
                organizationId: configRow.organization_id || null,
                batchId,
                clientVariant: validation.variant.id,
                platform: target.platform,
                arch: target.arch,
                packageType: target.package,
                provider: provider.id,
                rustdeskVersion: validation.normalized.rustdeskVersion,
                sourceCommit: sourceCommit.toLowerCase(),
                status: 'queued',
                logSummary: 'Preparing encrypted build payload.',
                expiresAt: null,
            });
            if (setAsLastBuild) {
                await db.setRealClientConfigLastBuild(configRow.id, {
                    id: buildId, platform: target.platform, arch: target.arch, packageType: target.package,
                    provider: provider.id, rustdeskVersion: validation.normalized.rustdeskVersion, status: 'queued',
                });
            }

            try {
                const cleanSecrets = secretValidation.secrets;
                const assets = await assetService.collectAssets(configRow.owner_user_id || requestedBy, validation.normalized.assets);
                const payload = {
                    schema: 'betterdesk-real-client-build/v1',
                    build: {
                        id: buildId,
                        batchId,
                        clientVariant: validation.variant.id,
                        target: target.id,
                        platform: target.platform,
                        arch: target.arch,
                        package: target.package,
                        rustdeskVersion: validation.normalized.rustdeskVersion,
                        sourceCommit: sourceCommit.toLowerCase(),
                    },
                    configuration: validation.normalized,
                    rustdeskCustomConfig: configService.compileRustDeskConfig(validation.normalized, cleanSecrets),
                    assets,
                };
                await payloadService.createEncryptedPayload(buildId, payload);
                const payloadUrl = `${config.realClient.publicBaseUrl}/api/generator/real-client/payload/${buildId}`;
                await db.updateRealClientBuild(buildId, { status: 'dispatching', logSummary: 'Dispatching encrypted build to GitHub Actions.' });
                const dispatch = await provider.dispatch({ build: buildRow, target, payloadUrl });
                const updated = await this.applyBuildUpdate(buildRow, dispatch);
                return { ok: true, build: serializeBuild(updated), warnings: validation.warnings };
            } catch (error) {
                await payloadService.deleteEncryptedPayload(buildId).catch(() => {});
                const failed = await db.updateRealClientBuild(buildId, {
                    status: 'failed', finishedAt: new Date().toISOString(),
                    errorMessage: maskText(error.message), logSummary: 'Build dispatch failed.',
                });
                await this.updateConfigLastStatus(failed);
                return { ok: false, statusCode: 502, errors: [{ field: 'build', message: maskText(error.message) }], build: serializeBuild(failed) };
            }
        });
    }

    async createBuildBatch({
        configId,
        providerId = 'github',
        oneTimeSecrets = {},
        targetIds = [],
        clientVariants = [],
    }, requestedBy) {
        const configRow = await db.getRealClientConfig(configId);
        if (!configRow) return { ok: false, statusCode: 404, errors: [{ field: 'configId', message: 'Configuration not found' }] };
        const secretValidation = validateOneTimeSecrets(oneTimeSecrets);
        if (!secretValidation.valid) return { ok: false, statusCode: 400, errors: [secretValidation.error] };
        const provider = this.providers.get(providerId);
        if (!provider) return { ok: false, statusCode: 400, errors: [{ field: 'provider', message: 'Unknown build provider' }] };
        const capability = provider.capabilities();
        if (!capability.enabled) return { ok: false, statusCode: 503, errors: [{ field: 'provider', message: capability.reason || 'Build provider is unavailable' }] };

        const rawConfig = parseJson(configRow.config_json, {});
        const selection = this.normalizeBatchSelection(targetIds, clientVariants);
        if (!selection.valid) return { ok: false, statusCode: 400, errors: selection.errors };

        const combinations = [];
        const preflightErrors = [];
        const warnings = [];
        for (const variantId of selection.variants) {
            for (const selectedTarget of selection.targets) {
                const validation = this.validateBuildConfiguration(
                    rawConfig,
                    providerId,
                    selectedTarget,
                    variantId,
                    secretValidation.secrets,
                );
                const label = `${variantId} / ${selectedTarget}`;
                if (!validation.valid) {
                    preflightErrors.push(...validation.errors.map((item) => ({
                        ...item,
                        field: `${variantId}.${selectedTarget}.${item.field || 'build'}`,
                        message: `${label}: ${item.message}`,
                    })));
                } else {
                    combinations.push({ targetId: selectedTarget, clientVariant: variantId });
                    warnings.push(...validation.warnings.map((item) => ({ ...item, message: `${label}: ${item.message}` })));
                }
            }
        }
        if (preflightErrors.length) {
            return { ok: false, statusCode: 400, errors: preflightErrors, warnings };
        }

        const batchId = configService.generateId();
        const results = await mapWithConcurrency(combinations, BATCH_DISPATCH_CONCURRENCY, (combination) => this.createBuild({
            configId,
            providerId,
            oneTimeSecrets: secretValidation.secrets,
            targetId: combination.targetId,
            clientVariant: combination.clientVariant,
            batchId,
            setAsLastBuild: false,
        }, requestedBy));
        const builds = results.map((result) => result.build).filter(Boolean);
        const representative = builds[builds.length - 1];
        if (representative) {
            await db.setRealClientConfigLastBuild(configRow.id, {
                id: representative.id,
                platform: representative.platform,
                arch: representative.arch,
                packageType: representative.package,
                provider: representative.provider,
                rustdeskVersion: representative.rustdesk_version,
                status: representative.status,
            });
        }
        return {
            ok: builds.length > 0,
            statusCode: builds.length ? 202 : 502,
            batchId,
            builds,
            warnings,
            errors: results.flatMap((result) => result.ok ? [] : (result.errors || [])),
            partial: results.some((result) => !result.ok),
        };
    }

    async applyBuildUpdate(build, update) {
        const fields = { ...update };
        if (TERMINAL.has(fields.status) && fields.status !== 'expired' && !build.finished_at
            && !Object.prototype.hasOwnProperty.call(fields, 'finishedAt')) {
            fields.finishedAt = new Date().toISOString();
        }
        if (fields.status === 'cancelled' && !build.cancelled_at
            && !Object.prototype.hasOwnProperty.call(fields, 'cancelledAt')) {
            fields.cancelledAt = fields.finishedAt || new Date().toISOString();
        }
        if (fields.status === 'ready' && !build.expires_at
            && !Object.prototype.hasOwnProperty.call(fields, 'expiresAt')) {
            const finished = new Date(fields.finishedAt || Date.now()).getTime();
            const retentionBase = Number.isFinite(finished) ? finished : Date.now();
            fields.expiresAt = new Date(retentionBase
                + config.realClient.artifactRetentionDays * 86400000).toISOString();
        }
        if (fields.logSummary != null) fields.logSummary = maskText(fields.logSummary);
        if (fields.errorMessage != null) fields.errorMessage = maskText(fields.errorMessage);
        const updated = await db.updateRealClientBuild(build.id, fields);
        if (updated && TERMINAL.has(updated.status)) await payloadService.deleteEncryptedPayload(updated.id).catch(() => {});
        if (updated) await this.updateConfigLastStatus(updated);
        return updated;
    }

    async updateConfigLastStatus(build) {
        if (!build || !build.config_id) return;
        const configRow = await db.getRealClientConfig(build.config_id);
        if (!configRow || configRow.last_build_id !== build.id) return;
        await db.setRealClientConfigLastBuild(build.config_id, {
            id: build.id, platform: build.platform, arch: build.arch, packageType: build.package_type,
            provider: build.provider, rustdeskVersion: build.rustdesk_version, status: build.status,
        });
    }

    async withBuildLock(id, operation) {
        const previous = this.buildLocks.get(id) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.buildLocks.set(id, current);
        try {
            return await current;
        } finally {
            if (this.buildLocks.get(id) === current) this.buildLocks.delete(id);
        }
    }

    async syncBuild(id) {
        return this.withBuildLock(id, () => this.syncBuildUnlocked(id));
    }

    async syncBuildUnlocked(id) {
        const build = await db.getRealClientBuild(id);
        if (!build) return null;
        if (TERMINAL.has(build.status)) return serializeBuild(build);
        const provider = this.providers.get(build.provider);
        if (!provider) {
            return serializeBuild(await this.applyBuildUpdate(build, { status: 'failed', errorMessage: 'Configured build provider is no longer available.' }));
        }
        try {
            const update = await provider.inspect(build);
            // Provider/API overloads are recoverable. Once a later poll
            // succeeds, remove the stale transient diagnostic instead of
            // showing it beside a healthy queued/building/ready run.
            if (!Object.prototype.hasOwnProperty.call(update, 'errorMessage')) update.errorMessage = '';
            return serializeBuild(await this.applyBuildUpdate(build, update));
        } catch (error) {
            // updated_at changes on every poll, so it cannot identify a stale
            // request. RustDesk builds may legitimately run for several hours;
            // keep transient provider failures recoverable until the overall
            // request is older than the provider timeout.
            const age = Date.now() - new Date(build.queued_at || build.created_at).getTime();
            if (age > PROVIDER_SYNC_FAILURE_TIMEOUT_MS) {
                return serializeBuild(await this.applyBuildUpdate(build, {
                    status: 'failed', finishedAt: new Date().toISOString(), errorMessage: maskText(error.message),
                }));
            }
            return serializeBuild(await this.applyBuildUpdate(build, {
                providerStatus: 'sync_error', errorMessage: maskText(error.message),
            }));
        }
    }

    async cancelBuild(id) {
        return this.withBuildLock(id, () => this.cancelBuildUnlocked(id));
    }

    async cancelBuildUnlocked(id) {
        const build = await db.getRealClientBuild(id);
        if (!build) return null;
        if (TERMINAL.has(build.status)) return serializeBuild(build);
        const provider = this.providers.get(build.provider);
        const update = provider
            ? await provider.cancel(build)
            : { status: 'cancelled', cancelledAt: new Date().toISOString() };
        return serializeBuild(await this.applyBuildUpdate(build, update));
    }

    async artifactForDownload(id) {
        const build = await db.getRealClientBuild(id);
        if (!build || build.status !== 'ready' || !build.artifact_path) return null;
        const artifactRoot = path.resolve(config.dataDir, 'real-client-artifacts');
        const filePath = path.resolve(build.artifact_path);
        const relative = path.relative(artifactRoot, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid artifact path');
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size !== Number(build.artifact_size)) throw new Error('Artifact integrity metadata does not match the stored file');
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
        const digest = hash.digest('hex');
        if (!/^[0-9a-f]{64}$/i.test(String(build.artifact_sha256 || ''))
            || digest !== String(build.artifact_sha256).toLowerCase()) {
            throw new Error('Artifact SHA-256 does not match the stored integrity metadata');
        }
        return { path: filePath, name: build.artifact_name, size: stat.size, sha256: build.artifact_sha256 };
    }

    async readPublicPayload(buildId) {
        const build = await db.getRealClientBuild(buildId);
        if (!build || TERMINAL.has(build.status)) return null;
        return payloadService.readEncryptedPayload(buildId);
    }

    async syncActiveBuilds() {
        if (this.syncing) return;
        this.syncing = true;
        try {
            const builds = await db.listActiveRealClientBuilds();
            await mapWithConcurrency(builds, BATCH_DISPATCH_CONCURRENCY, async (build) => {
                try {
                    await this.syncBuild(build.id);
                } catch (error) {
                    // A damaged row or transient database failure for one run
                    // must not starve every other output in a one-click batch.
                    console.warn(`[real-client] could not synchronize build ${build.id}:`, maskText(error.message));
                }
            });
            await this.cleanupExpiredArtifacts();
        } finally {
            this.syncing = false;
        }
    }

    async cleanupExpiredArtifacts() {
        const rows = await db.listExpiredRealClientBuilds();
        const root = path.resolve(config.dataDir, 'real-client-artifacts');
        for (const build of rows) {
            await this.withBuildLock(build.id, async () => {
                const current = await db.getRealClientBuild(build.id);
                if (!current || !current.expires_at || new Date(current.expires_at).getTime() > Date.now()) return;
                if (current.artifact_path) {
                    const dir = path.resolve(path.dirname(current.artifact_path));
                    const relative = path.relative(root, dir);
                    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
                        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
                    }
                }
                await payloadService.deleteEncryptedPayload(current.id).catch(() => {});
                const updated = await db.updateRealClientBuild(current.id, {
                    status: current.status === 'ready' ? 'expired' : current.status,
                    artifactName: null, artifactPath: null, artifactSize: 0,
                    artifactSha256: null, expiresAt: null,
                });
                await this.updateConfigLastStatus(updated);
            });
        }
        const referencedAssets = new Set();
        for (const configRow of await db.listRealClientConfigs()) {
            const assets = parseJson(configRow.assets_json, {});
            for (const id of Object.values(assets)) if (id) referencedAssets.add(id);
        }
        await assetService.cleanupOrphans(referencedAssets);
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.syncActiveBuilds().catch((error) => console.warn('[real-client] background sync:', maskText(error.message)));
        }, config.realClient.pollIntervalMs);
        this.timer.unref();
        setImmediate(() => this.syncActiveBuilds().catch((error) => console.warn('[real-client] initial sync:', maskText(error.message))));
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = new RealClientBuildService();
module.exports.serializeConfig = serializeConfig;
module.exports.serializeBuild = serializeBuild;
