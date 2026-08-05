'use strict';

const crypto = require('crypto');

const TARGETS = Object.freeze([
    { id: 'windows-x64-exe', platform: 'windows', arch: 'x86_64', package: 'exe', label: 'Windows 64-bit (EXE)' },
    { id: 'windows-x64-msi', platform: 'windows', arch: 'x86_64', package: 'msi', label: 'Windows 64-bit (MSI)' },
    { id: 'windows-x86-exe', platform: 'windows', arch: 'x86', package: 'exe', label: 'Windows 32-bit (EXE)' },
    { id: 'linux-x64-deb', platform: 'linux', arch: 'x86_64', package: 'deb', label: 'Linux x86_64 (DEB)' },
    { id: 'linux-x64-appimage', platform: 'linux', arch: 'x86_64', package: 'appimage', label: 'Linux x86_64 (AppImage)' },
    { id: 'linux-x64-flatpak', platform: 'linux', arch: 'x86_64', package: 'flatpak', label: 'Linux x86_64 (Flatpak)' },
    { id: 'linux-arm64-deb', platform: 'linux', arch: 'aarch64', package: 'deb', label: 'Linux ARM64 (DEB)' },
    { id: 'linux-arm64-appimage', platform: 'linux', arch: 'aarch64', package: 'appimage', label: 'Linux ARM64 (AppImage)' },
    { id: 'linux-arm64-flatpak', platform: 'linux', arch: 'aarch64', package: 'flatpak', label: 'Linux ARM64 (Flatpak)' },
    { id: 'android-arm64-apk', platform: 'android', arch: 'aarch64', package: 'apk', label: 'Android ARM64 (APK)' },
    { id: 'android-armv7-apk', platform: 'android', arch: 'armv7', package: 'apk', label: 'Android ARMv7 (APK)' },
    { id: 'android-x64-apk', platform: 'android', arch: 'x86_64', package: 'apk', label: 'Android x86_64 (APK)' },
    { id: 'macos-x64-dmg', platform: 'macos', arch: 'x86_64', package: 'dmg', label: 'macOS Intel (DMG)' },
    { id: 'macos-arm64-dmg', platform: 'macos', arch: 'aarch64', package: 'dmg', label: 'macOS Apple Silicon (DMG)' },
]);

const TARGET_BY_ID = new Map(TARGETS.map((target) => [target.id, target]));
const CLIENT_VARIANTS = Object.freeze([
    {
        id: 'client',
        label: 'Full client',
        description: 'Uses the saved access, installation and connection-direction settings unchanged.',
    },
    {
        id: 'quicksupport',
        label: 'QuickSupport',
        description: 'Incoming-only support client with a distinct name; installation is disabled where the platform supports portable operation.',
    },
]);
const VARIANT_BY_ID = new Map(CLIENT_VARIANTS.map((variant) => [variant.id, variant]));
const ENUMS = Object.freeze({
    direction: new Set(['incoming', 'outgoing', 'both']),
    networkScope: new Set(['default', 'override']),
    theme: new Set(['system', 'light', 'dark']),
    themeScope: new Set(['default', 'override']),
    approvalMode: new Set(['password', 'click', 'password-click']),
    permissionsScope: new Set(['default', 'override']),
    permissionPreset: new Set(['custom', 'full', 'view']),
});

const BOOL_FIELDS = Object.freeze([
    'disableInstallation', 'disableSettings', 'allowAutoDisconnect', 'denyLanDiscovery',
    'directIpAccess', 'removeWallpaper', 'hideConnectionManager',
    'cycleMonitor', 'offlineIndicator', 'removeVersionNotification', 'delayFix',
]);

const PERMISSION_FIELDS = Object.freeze([
    'keyboard', 'clipboard', 'fileTransfer', 'audio', 'tcpTunnel', 'remoteRestart',
    'recording', 'blockInput', 'remoteConfig', 'printer', 'camera', 'terminal',
]);

const RESERVED_SECRET_KEYS = new Set([
    'permanentPassword', 'githubToken', 'token', 'privateKey', 'signingKey',
    'keystorePassword', 'certificatePassword', 'zipPassword',
]);
// These keys are owned by dedicated, validated form fields. Allowing a manual
// map to replace them after validation would make the saved UI disagree with
// the generated client and could bypass access/network policy checks.
const MANAGED_SETTING_KEYS = new Set([
    'access-mode', 'approve-mode', 'verification-method', 'direct-server',
    'allow-hide-cm', 'allow-remove-wallpaper',
    'enable-keyboard', 'enable-clipboard', 'enable-file-transfer', 'enable-audio',
    'enable-tunnel', 'enable-remote-restart', 'enable-record-session',
    'enable-block-input', 'allow-remote-config-modification',
    'enable-remote-printer', 'enable-camera', 'enable-terminal',
    'custom-rendezvous-server', 'relay-server', 'api-server', 'key',
    'theme', 'allow-darktheme',
    'allow-monitor-switch-main-toolbar', 'allow-monitor-switch-min-toolbar',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultConfig() {
    return {
        rustdeskVersion: '1.4.9',
        target: 'windows-x64-exe',
        idServer: '',
        relayServer: '',
        apiServer: '',
        publicKey: '',
        appName: 'RustDesk',
        executableName: 'rustdesk',
        companyName: '',
        customUrl: '',
        downloadUrl: '',
        androidAppId: 'com.carriez.flutter_hbb',
        macosBundleId: 'com.carriez.flutterHbb',
        direction: 'both',
        networkScope: 'override',
        theme: 'system',
        themeScope: 'default',
        approvalMode: 'password-click',
        permissionsScope: 'default',
        permissionPreset: 'custom',
        delayFix: true,
        disableInstallation: false,
        disableSettings: false,
        allowAutoDisconnect: false,
        denyLanDiscovery: false,
        directIpAccess: false,
        removeWallpaper: true,
        hideConnectionManager: false,
        cycleMonitor: false,
        offlineIndicator: false,
        removeVersionNotification: false,
        permissions: Object.fromEntries(PERMISSION_FIELDS.map((name) => [name, name !== 'remoteConfig'])),
        defaultSettings: {},
        overrideSettings: {},
        assets: { icon: null, logo: null, privacy: null },
    };
}

function cleanString(value, max = 500) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function boundedString(value, field, max, errors) {
    const raw = String(value == null ? '' : value).trim();
    if (raw.length > max) {
        errors.push({
            field,
            code: 'too_long',
            message: `${field} may contain at most ${max} characters`,
        });
    }
    return raw.slice(0, max);
}

function normalizeRustDeskVersion(value) {
    const normalized = cleanString(value, 80);
    return {
        valid: /^(?:master|nightly|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(normalized),
        value: normalized,
    };
}

function cleanBrandingString(value, field, max, errors) {
    const normalized = boundedString(value, field, max, errors).normalize('NFC');
    // Preserve legitimate UTF-8 branding (including CJK and punctuation), but
    // reject characters that can alter generated source/log presentation.
    if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/iu.test(normalized)) {
        errors.push({
            field,
            code: 'invalid_branding_text',
            message: `${field} contains control, bidirectional or invalid Unicode characters`,
        });
    }
    return normalized;
}

function cleanEndpoint(value, field, errors, {
    allowPath = false,
    allowedSchemes = allowPath ? ['http:', 'https:'] : [],
    requireScheme = false,
    forbidQueryAndFragment = false,
} = {}) {
    const raw = boundedString(value, field, 512, errors);
    if (!raw) return '';
    if (/\s|[\x00-\x1f\x7f]/.test(raw)) {
        errors.push({ field, code: 'invalid_endpoint', message: `${field} contains invalid characters` });
        return raw;
    }
    try {
        const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
        const probe = explicitScheme ? new URL(raw) : new URL(`tcp://${raw}`);
        if (!probe.hostname || probe.username || probe.password || (requireScheme && !explicitScheme)
            || (explicitScheme && !allowedSchemes.includes(probe.protocol))
            || (forbidQueryAndFragment && (probe.search || probe.hash))
            || (!allowPath && ((probe.pathname && probe.pathname !== '/') || probe.search || probe.hash))) {
            throw new Error('invalid endpoint');
        }
    } catch (_) {
        errors.push({
            field,
            code: 'invalid_endpoint',
            message: requireScheme
                ? `${field} must be an HTTP(S) URL without embedded credentials`
                : allowPath
                ? `${field} must be a hostname or HTTP(S) URL without embedded credentials`
                : `${field} must be a hostname or hostname:port without a URL scheme`,
        });
    }
    return raw;
}

function normalizeSettingMap(value, field, errors) {
    if (value == null || value === '') return {};
    let source = value;
    if (typeof value === 'string') {
        source = {};
        for (const rawLine of value.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) {
                errors.push({ field, code: 'invalid_setting', message: `${field} entries must use key=value` });
                continue;
            }
            source[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        errors.push({ field, code: 'invalid_settings', message: `${field} must be an object or key=value lines` });
        return {};
    }
    const output = {};
    for (const [rawKey, rawValue] of Object.entries(source)) {
        const rawKeyText = String(rawKey == null ? '' : rawKey).trim();
        const key = boundedString(rawKey, field, 80, errors);
        if (rawKeyText.length > 80) continue;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) {
            errors.push({ field, code: 'invalid_setting_key', message: `Invalid setting key: ${key || '(empty)'}` });
            continue;
        }
        if (/(?:password|token|secret|private[._-]?key|signing[._-]?key|keystore)/i.test(key)) {
            errors.push({ field, code: 'secret_setting_forbidden', message: `Sensitive setting ${key} must not be stored in a saved configuration` });
            continue;
        }
        if (MANAGED_SETTING_KEYS.has(key.toLowerCase())) {
            errors.push({
                field,
                code: 'managed_setting_conflict',
                message: `Setting ${key} is controlled by a dedicated generator field`,
            });
            continue;
        }
        const rawValueText = String(rawValue == null ? '' : rawValue).trim();
        const settingValue = boundedString(rawValue, field, 500, errors);
        if (rawValueText.length > 500) continue;
        if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(settingValue)) {
            errors.push({ field, code: 'invalid_setting_value', message: `Setting ${key} contains unsupported control or Unicode direction characters` });
            continue;
        }
        if (Object.keys(output).length >= 100) {
            errors.push({ field, code: 'too_many_settings', message: `${field} may contain at most 100 settings` });
            break;
        }
        output[key] = settingValue;
    }
    return output;
}

function normalizeConfig(raw = {}, options = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const base = defaultConfig();
    const errors = [];
    const warnings = [];
    const normalized = { ...base };

    const sourceVersion = normalizeRustDeskVersion(input.rustdeskVersion || base.rustdeskVersion);
    normalized.rustdeskVersion = sourceVersion.value;
    if (!sourceVersion.valid) {
        errors.push({ field: 'rustdeskVersion', code: 'invalid_version', message: 'Use master, nightly or an exact semantic version' });
    }
    if (options.availableRustDeskVersions && !options.availableRustDeskVersions.has(normalized.rustdeskVersion)) {
        errors.push({ field: 'rustdeskVersion', code: 'version_not_configured', message: 'This RustDesk version is not enabled and E2E-verified by the selected build provider' });
    }

    normalized.target = cleanString(input.target || base.target, 80);
    const target = TARGET_BY_ID.get(normalized.target);
    if (!target) errors.push({ field: 'target', code: 'unsupported_target', message: 'Unknown build target' });
    if (options.availableBuildCombinations && target
        && !options.availableBuildCombinations.has(`${normalized.target}@${normalized.rustdeskVersion}`)) {
        errors.push({ field: 'target', code: 'combination_not_configured', message: 'This target and RustDesk version combination has not passed E2E verification for the selected provider' });
    }

    normalized.idServer = cleanEndpoint(input.idServer, 'idServer', errors);
    normalized.relayServer = cleanEndpoint(input.relayServer, 'relayServer', errors);
    normalized.apiServer = cleanEndpoint(input.apiServer, 'apiServer', errors, {
        allowPath: true,
        forbidQueryAndFragment: true,
    });
    normalized.publicKey = boundedString(input.publicKey, 'publicKey', 2048, errors).replace(/\s+/g, '');
    if (!normalized.idServer) errors.push({ field: 'idServer', code: 'required', message: 'ID server is required' });
    if (!normalized.publicKey) errors.push({ field: 'publicKey', code: 'required', message: 'Server public key is required' });
    else {
        try {
            const decodedKey = Buffer.from(normalized.publicKey, 'base64');
            const canonical = decodedKey.toString('base64').replace(/=+$/, '');
            if (decodedKey.length !== 32 || canonical !== normalized.publicKey.replace(/=+$/, '')) throw new Error('invalid key');
        } catch (_) {
            errors.push({ field: 'publicKey', code: 'invalid_public_key', message: 'Server public key must be a valid 32-byte Ed25519 key encoded as Base64' });
        }
    }

    normalized.appName = cleanBrandingString(input.appName || base.appName, 'appName', 64, errors);
    normalized.executableName = boundedString(input.executableName || base.executableName, 'executableName', 64, errors).replace(/\.(exe|msi|dmg|apk|deb)$/i, '');
    normalized.companyName = cleanBrandingString(input.companyName, 'companyName', 100, errors);
    normalized.customUrl = cleanEndpoint(input.customUrl, 'customUrl', errors, { allowPath: true, requireScheme: true });
    normalized.downloadUrl = cleanEndpoint(input.downloadUrl, 'downloadUrl', errors, { allowPath: true, requireScheme: true });
    normalized.androidAppId = boundedString(input.androidAppId || base.androidAppId, 'androidAppId', 150, errors);
    normalized.macosBundleId = boundedString(input.macosBundleId || base.macosBundleId, 'macosBundleId', 255, errors);
    if (!normalized.appName) errors.push({ field: 'appName', code: 'required', message: 'Application name is required' });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized.executableName)) {
        errors.push({ field: 'executableName', code: 'invalid_filename', message: 'Output filename may contain letters, numbers, dot, underscore and dash' });
    }
    if (target && target.platform === 'android' && !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,}$/.test(normalized.androidAppId)) {
        errors.push({ field: 'androidAppId', code: 'invalid_android_id', message: 'Android application ID is invalid' });
    }
    if (target && target.platform === 'macos'
        && !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(normalized.macosBundleId)) {
        errors.push({ field: 'macosBundleId', code: 'invalid_macos_bundle_id', message: 'macOS bundle identifier is invalid' });
    }
    if (target && target.platform === 'macos') {
        for (const field of ['appName', 'companyName']) {
            if (/[\\/$#;=]/.test(normalized[field])) {
                errors.push({
                    field,
                    code: 'invalid_macos_branding',
                    message: `${field} contains a character that is not safe in an Xcode build setting`,
                });
            }
        }
    }
    if (target && target.id === 'windows-x64-msi') {
        for (const field of ['appName', 'companyName']) {
            if (/[&<>"']/.test(normalized[field])) {
                errors.push({
                    field,
                    code: 'invalid_msi_branding',
                    message: `${field} contains an XML metacharacter that is not supported by the RustDesk 1.4.9 MSI toolchain`,
                });
            }
        }
    }

    for (const [field, allowed] of Object.entries(ENUMS)) {
        const rawValue = field === 'approvalMode' && input[field] === 'both' ? 'password-click' : input[field];
        normalized[field] = cleanString(rawValue || base[field], 40).toLowerCase();
        if (!allowed.has(normalized[field])) {
            errors.push({ field, code: 'invalid_choice', message: `Unsupported ${field} value` });
        }
    }
    for (const field of BOOL_FIELDS) normalized[field] = input[field] == null ? base[field] : !!input[field];
    normalized.permissions = {};
    for (const field of PERMISSION_FIELDS) {
        normalized.permissions[field] = input.permissions && input.permissions[field] != null
            ? !!input.permissions[field]
            : base.permissions[field];
    }

    normalized.defaultSettings = normalizeSettingMap(input.defaultSettings, 'defaultSettings', errors);
    normalized.overrideSettings = normalizeSettingMap(input.overrideSettings, 'overrideSettings', errors);
    const inputAssets = input.assets && typeof input.assets === 'object' ? input.assets : {};
    normalized.assets = {};
    for (const kind of ['icon', 'logo', 'privacy']) {
        const asset = cleanString(inputAssets[kind], 100);
        normalized.assets[kind] = UUID.test(asset) ? asset : null;
        if (asset && !normalized.assets[kind]) {
            errors.push({ field: `assets.${kind}`, code: 'invalid_asset', message: `Invalid ${kind} asset reference` });
        }
    }

    for (const key of Object.keys(input)) {
        if (RESERVED_SECRET_KEYS.has(key)) {
            warnings.push({ field: key, code: 'secret_not_saved', message: `${key} is accepted only for a single build and is never saved` });
        }
    }

    if (target && target.platform === 'windows' && target.arch === 'x86' && normalized.theme === 'system') {
        warnings.push({ field: 'theme', code: 'x86_theme_limit', message: 'Windows 32-bit uses the legacy Sciter theme controls' });
    }
    if (target && target.platform === 'android' && normalized.disableInstallation) {
        warnings.push({ field: 'disableInstallation', code: 'platform_limited', message: 'Android packages are always installable; this setting is retained for other targets and omitted from Android builds' });
    }
    if (target && target.platform !== 'windows' && normalized.hideConnectionManager) {
        warnings.push({ field: 'hideConnectionManager', code: 'platform_limited', message: 'Hide connection manager is only verified on Windows' });
    }
    if (normalized.hideConnectionManager && normalized.approvalMode !== 'password') {
        errors.push({
            field: 'hideConnectionManager',
            code: 'incompatible',
            message: 'Hide connection manager requires Password approval mode and a permanent password supplied for the build',
        });
    }
    if (normalized.assets.privacy && (!target || target.platform !== 'windows' || target.arch !== 'x86_64')) {
        warnings.push({ field: 'assets.privacy', code: 'platform_limited', message: 'Custom privacy-screen artwork is retained for Windows x64 and omitted from other platform builds' });
    }
    if (target && target.id === 'windows-x86-exe' && (normalized.cycleMonitor || normalized.offlineIndicator)) {
        errors.push({ field: 'target', code: 'incompatible', message: 'Cycle-monitor and offline-indicator source patches are not available in RDGen Windows x86 workflow' });
    }

    if (options.availableTargetIds && !options.availableTargetIds.has(normalized.target)) {
        errors.push({ field: 'target', code: 'target_not_configured', message: 'This target is not enabled and verified by the configured build provider' });
    }

    return { valid: errors.length === 0, errors, warnings, normalized, target };
}

function compileRustDeskConfig(config, oneTimeSecrets = {}) {
    const custom = { 'default-settings': {}, 'override-settings': {} };
    if (config.direction !== 'both') custom['conn-type'] = config.direction;
    if (config.disableInstallation) custom['disable-installation'] = 'Y';
    if (config.disableSettings) custom['disable-settings'] = 'Y';
    if (config.appName && config.appName.toLowerCase() !== 'rustdesk') custom['app-name'] = config.appName;
    if (oneTimeSecrets.permanentPassword) custom.password = String(oneTimeSecrets.permanentPassword).slice(0, 256);
    custom['enable-lan-discovery'] = config.denyLanDiscovery ? 'N' : 'Y';
    custom['allow-auto-disconnect'] = config.allowAutoDisconnect ? 'Y' : 'N';

    const permissionKeys = {
        keyboard: 'enable-keyboard', clipboard: 'enable-clipboard', fileTransfer: 'enable-file-transfer',
        audio: 'enable-audio', tcpTunnel: 'enable-tunnel', remoteRestart: 'enable-remote-restart',
        recording: 'enable-record-session', blockInput: 'enable-block-input',
        remoteConfig: 'allow-remote-config-modification', printer: 'enable-remote-printer',
        camera: 'enable-camera', terminal: 'enable-terminal',
    };
    const permissionSettings = {
        'approve-mode': config.approvalMode,
        'verification-method': config.hideConnectionManager ? 'use-permanent-password' : 'use-both-passwords',
        'access-mode': config.permissionPreset,
        'direct-server': config.directIpAccess ? 'Y' : 'N',
        'allow-hide-cm': config.hideConnectionManager ? 'Y' : 'N',
        'allow-remove-wallpaper': config.removeWallpaper ? 'Y' : 'N',
    };
    for (const [field, key] of Object.entries(permissionKeys)) permissionSettings[key] = config.permissions[field] ? 'Y' : 'N';

    const permissionScope = config.permissionsScope === 'override' ? 'override-settings' : 'default-settings';
    Object.assign(custom[permissionScope], permissionSettings);
    const networkScope = config.networkScope === 'default' ? 'default-settings' : 'override-settings';
    custom[networkScope]['custom-rendezvous-server'] = config.idServer;
    custom[networkScope].key = config.publicKey;
    if (config.relayServer) custom[networkScope]['relay-server'] = config.relayServer;
    if (config.apiServer) custom[networkScope]['api-server'] = config.apiServer;
    if (config.theme !== 'system') {
        const themeScope = config.themeScope === 'override' ? 'override-settings' : 'default-settings';
        if (config.target === 'windows-x86-exe') custom[themeScope]['allow-darktheme'] = config.theme === 'dark' ? 'Y' : 'N';
        else custom[themeScope].theme = config.theme;
    }
    // RustDesk 1.4.9 has native cycle-monitor controls. Prefer its signed
    // configuration switches over RDGen's now-obsolete source patch.
    if (config.cycleMonitor) {
        custom['default-settings']['allow-monitor-switch-main-toolbar'] = 'Y';
        custom['default-settings']['allow-monitor-switch-min-toolbar'] = 'Y';
    }
    // Non-managed advanced values are applied last. Managed access, network
    // and theme keys were rejected during normalization above.
    Object.assign(custom['default-settings'], config.defaultSettings || {});
    Object.assign(custom['override-settings'], config.overrideSettings || {});

    return {
        host: config.idServer,
        relay: config.relayServer,
        api: config.apiServer,
        key: config.publicKey,
        custom,
    };
}

function targetById(id) {
    return TARGET_BY_ID.get(id) || null;
}

function buildVariantById(id) {
    return VARIANT_BY_ID.get(id) || null;
}

function appendVariantSuffix(value, suffix, max) {
    const base = String(value || '').trim();
    if (base.toLowerCase().endsWith(suffix.toLowerCase())) return base.slice(0, max);
    return `${base.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
}

/**
 * Produce an ephemeral, target-specific configuration for one build.
 * Saved configurations remain the single source of truth; the variant overlay
 * is stored only in the immutable build snapshot and encrypted payload.
 */
function deriveConfigForBuild(rawConfig, { targetId, variantId = 'client' } = {}) {
    const target = targetById(targetId);
    const variant = buildVariantById(variantId);
    if (!target) throw new Error(`Unknown build target: ${targetId}`);
    if (!variant) throw new Error(`Unknown client variant: ${variantId}`);

    const derived = {
        ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
        target: target.id,
        assets: { ...((rawConfig && rawConfig.assets) || {}) },
        permissions: { ...((rawConfig && rawConfig.permissions) || {}) },
        defaultSettings: { ...((rawConfig && rawConfig.defaultSettings) || {}) },
        overrideSettings: { ...((rawConfig && rawConfig.overrideSettings) || {}) },
    };
    const adjustments = [];
    if (variant.id === 'quicksupport') {
        derived.direction = 'incoming';
        derived.hideConnectionManager = false;
        derived.appName = appendVariantSuffix(derived.appName || 'RustDesk', ' QuickSupport', 64);
        derived.executableName = appendVariantSuffix(derived.executableName || 'rustdesk', '-quicksupport', 64);
        if (target.platform === 'android') {
            // Android always produces an installable APK. This exception is
            // surfaced in the build plan instead of silently sending an
            // incompatible disable-installation setting.
            derived.disableInstallation = false;
            adjustments.push({
                code: 'android_quicksupport_installable',
                message: 'Android QuickSupport is incoming-only but remains an installable APK.',
            });
        } else {
            derived.disableInstallation = true;
        }
        adjustments.push({
            code: 'quicksupport_profile',
            message: 'QuickSupport uses incoming-only mode, a distinct product filename and a visible connection window.',
        });
    }
    if (target.platform === 'android' && derived.disableInstallation) {
        derived.disableInstallation = false;
        adjustments.push({
            code: 'android_installation_required',
            message: 'Disable installation is omitted because Android outputs must remain installable APKs.',
        });
    }
    if (target.platform !== 'windows' && derived.hideConnectionManager) {
        derived.hideConnectionManager = false;
        adjustments.push({
            code: 'hide_connection_manager_omitted',
            message: 'Hide connection manager is omitted because it is verified only for Windows outputs.',
        });
    }
    if (derived.assets.privacy && (target.platform !== 'windows' || target.arch !== 'x86_64')) {
        derived.assets.privacy = null;
        adjustments.push({
            code: 'privacy_asset_omitted',
            message: 'The custom privacy-screen image is omitted because it is supported only by Windows x64.',
        });
    }
    return { config: derived, target, variant, adjustments };
}

function generateId() {
    return crypto.randomUUID();
}

module.exports = {
    TARGETS,
    CLIENT_VARIANTS,
    PERMISSION_FIELDS,
    defaultConfig,
    normalizeConfig,
    compileRustDeskConfig,
    normalizeRustDeskVersion,
    targetById,
    buildVariantById,
    deriveConfigForBuild,
    generateId,
};
