import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = Object.freeze({
    'windows-x64-exe': { platform: 'windows', arch: 'x86_64', package: 'exe' },
    'windows-x64-msi': { platform: 'windows', arch: 'x86_64', package: 'msi' },
    'windows-x86-exe': { platform: 'windows', arch: 'x86', package: 'exe' },
    'linux-x64-deb': { platform: 'linux', arch: 'x86_64', package: 'deb' },
    'linux-x64-appimage': { platform: 'linux', arch: 'x86_64', package: 'appimage' },
    'linux-x64-flatpak': { platform: 'linux', arch: 'x86_64', package: 'flatpak' },
    'linux-arm64-deb': { platform: 'linux', arch: 'aarch64', package: 'deb' },
    'linux-arm64-appimage': { platform: 'linux', arch: 'aarch64', package: 'appimage' },
    'linux-arm64-flatpak': { platform: 'linux', arch: 'aarch64', package: 'flatpak' },
    'android-arm64-apk': { platform: 'android', arch: 'aarch64', package: 'apk' },
    'android-armv7-apk': { platform: 'android', arch: 'armv7', package: 'apk' },
    'android-x64-apk': { platform: 'android', arch: 'x86_64', package: 'apk' },
    'macos-x64-dmg': { platform: 'macos', arch: 'x86_64', package: 'dmg' },
    'macos-arm64-dmg': { platform: 'macos', arch: 'aarch64', package: 'dmg' },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const UNSAFE_TEXT = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/iu;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value;
}

function requireText(value, name, max, { optional = false } = {}) {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string' || !value || value.length > max || UNSAFE_TEXT.test(value)) {
        throw new Error(`${name} contains invalid text`);
    }
    return value.normalize('NFC');
}

function parseServerEndpoint(value, name, { optional = false } = {}) {
    const address = requireText(value, name, 512, { optional });
    if (!address) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) || /\s/.test(address)) {
        throw new Error(`${name} must be a hostname or hostname:port`);
    }
    let parsed;
    try {
        parsed = new URL(`tcp://${address}`);
    } catch (_) {
        throw new Error(`${name} must be a valid hostname or hostname:port`);
    }
    if (!parsed.hostname || parsed.username || parsed.password
        || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
        throw new Error(`${name} must be a hostname or hostname:port without credentials or paths`);
    }
    const port = parsed.port ? Number(parsed.port) : null;
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error(`${name} port is invalid`);
    }
    return { address, host: parsed.hostname, port };
}

function parseApiEndpoint(value) {
    const address = requireText(value, 'configuration.apiServer', 512, { optional: true });
    if (!address) return null;
    const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(address);
    let parsed;
    try {
        parsed = new URL(explicitScheme ? address : `https://${address}`);
    } catch (_) {
        throw new Error('configuration.apiServer is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
        throw new Error('configuration.apiServer must be an HTTP(S) endpoint without credentials, query or fragment');
    }
    return { address, protocol: explicitScheme ? parsed.protocol : null, host: parsed.hostname, port: parsed.port ? Number(parsed.port) : null };
}

function parseHttpLink(value, name) {
    const address = requireText(value, name, 512, { optional: true });
    if (!address) return '';
    let parsed;
    try {
        parsed = new URL(address);
    } catch (_) {
        throw new Error(`${name} is invalid`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error(`${name} must be an HTTP(S) URL without credentials`);
    }
    return address;
}

function booleanSetting(value, name) {
    if (value == null) return false;
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
    return value;
}

function validatePublicKey(value) {
    const encoded = requireText(value, 'configuration.publicKey', 2048).replace(/\s+/g, '');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        throw new Error('configuration.publicKey must be a canonical Base64-encoded 32-byte Ed25519 key');
    }
    return encoded;
}

async function writePrivate(file, value) {
    await fs.writeFile(file, value, { mode: 0o600, flag: 'wx' });
}

const [payloadPath = '.betterdesk-build/payload.json', outputDir = '.betterdesk-build/input'] = process.argv.slice(2);
const raw = await fs.readFile(payloadPath, 'utf8');
const payload = requireObject(JSON.parse(raw), 'payload');
const build = requireObject(payload.build, 'build');
const configuration = requireObject(payload.configuration, 'configuration');
const customConfig = requireObject(payload.rustdeskCustomConfig, 'rustdeskCustomConfig');

if (payload.schema !== 'betterdesk-real-client-build/v1') throw new Error('Unsupported build payload');
if (!UUID.test(build.id || '')) throw new Error('Invalid build ID');
if (build.batchId != null && !UUID.test(build.batchId)) throw new Error('Invalid build batch ID');
if (!['client', 'quicksupport'].includes(build.clientVariant || 'client')) throw new Error('Invalid client variant');
const target = TARGETS[build.target];
if (!target) throw new Error('Unsupported build target');
if (configuration.target !== build.target || build.platform !== target.platform
    || build.arch !== target.arch || build.package !== target.package) {
    throw new Error('Build target metadata does not match the allow-listed target');
}

const sourceRevision = requireText(build.rustdeskVersion, 'build.rustdeskVersion', 80);
if (!/^(?:master|nightly|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(sourceRevision)
    || configuration.rustdeskVersion !== sourceRevision) {
    throw new Error('RustDesk source revision metadata does not match');
}
if (!GIT_COMMIT.test(build.sourceCommit || '')) {
    throw new Error('Build source commit must be an immutable 40-character Git SHA');
}

const id = parseServerEndpoint(configuration.idServer, 'configuration.idServer');
const relay = parseServerEndpoint(configuration.relayServer, 'configuration.relayServer', { optional: true });
const api = parseApiEndpoint(configuration.apiServer);
const publicKey = validatePublicKey(configuration.publicKey);
const appName = requireText(configuration.appName, 'configuration.appName', 64);
const companyName = requireText(configuration.companyName, 'configuration.companyName', 100, { optional: true });
const executableName = requireText(configuration.executableName, 'configuration.executableName', 64);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(executableName)) throw new Error('configuration.executableName is invalid');
const customUrl = parseHttpLink(configuration.customUrl, 'configuration.customUrl');
const downloadUrl = parseHttpLink(configuration.downloadUrl, 'configuration.downloadUrl');
const androidAppId = requireText(configuration.androidAppId, 'configuration.androidAppId', 150);
if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,}$/.test(androidAppId)) {
    throw new Error('configuration.androidAppId is invalid');
}
const macosBundleId = requireText(configuration.macosBundleId, 'configuration.macosBundleId', 255);
if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(macosBundleId)) {
    throw new Error('configuration.macosBundleId is invalid');
}

const buildPlan = {
    schema: 'betterdesk-real-client-plan/v1',
    buildId: build.id,
    batchId: build.batchId || null,
    clientVariant: build.clientVariant || 'client',
    target: build.target,
    platform: target.platform,
    arch: target.arch,
    package: target.package,
    sourceRevision,
    sourceCommit: build.sourceCommit.toLowerCase(),
    network: { id, relay, api, publicKey },
    branding: {
        appName,
        companyName,
        executableName,
        customUrl,
        downloadUrl,
        androidAppId,
        macosBundleId,
    },
    sourcePatches: {
        connectionDelay: booleanSetting(configuration.delayFix, 'configuration.delayFix') ? 'revision-guarded' : 'disabled',
        cycleMonitor: booleanSetting(configuration.cycleMonitor, 'configuration.cycleMonitor') ? 'native-toolbar-setting' : 'disabled',
        offlineIndicator: booleanSetting(configuration.offlineIndicator, 'configuration.offlineIndicator') ? 'revision-guarded' : 'disabled',
        hideConnectionManager: booleanSetting(configuration.hideConnectionManager, 'configuration.hideConnectionManager') ? 'revision-guarded' : 'disabled',
        removeVersionNotification: booleanSetting(configuration.removeVersionNotification, 'configuration.removeVersionNotification') ? 'custom-client-native-guard' : 'disabled',
        customConfigVerification: 'ed25519-required',
    },
    assets: { icon: false, logo: false, privacy: false },
};

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await writePrivate(path.join(outputDir, 'custom-config.json'), JSON.stringify(customConfig));
await writePrivate(path.join(outputDir, 'build-config.json'), JSON.stringify({ build, configuration }));

for (const kind of ['icon', 'logo', 'privacy']) {
    const asset = payload.assets?.[kind];
    if (!asset) continue;
    if (asset.mime !== 'image/png' || !UUID.test(asset.id || '')) throw new Error(`Invalid ${kind} asset`);
    const data = Buffer.from(asset.data || '', 'base64');
    if (data.length > 5 * 1024 * 1024 || data.length < 24) throw new Error(`${kind} asset size is invalid`);
    if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${kind} asset is not PNG`);
    await writePrivate(path.join(outputDir, `${kind}.png`), data);
    buildPlan.assets[kind] = true;
}

// This plan contains only validated, non-secret instructions for the
// source-revision-specific build adapter. The one-time password remains only
// in custom-config.json and must never be interpolated into shell commands.
await writePrivate(path.join(outputDir, 'build-plan.json'), JSON.stringify(buildPlan, null, 2));
process.stdout.write('Build input extracted without printing sensitive values.\n');
