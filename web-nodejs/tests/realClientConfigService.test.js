'use strict';

const service = require('../services/realClientConfigService');

function validConfig(overrides = {}) {
    return {
        ...service.defaultConfig(),
        idServer: 'id.example.com:21116',
        relayServer: 'relay.example.com:21117',
        apiServer: 'https://api.example.com/api',
        publicKey: Buffer.alloc(32, 7).toString('base64'),
        ...overrides,
    };
}

describe('Real Client configuration', () => {
    test('uses the current RDGen stable release instead of mutable master by default', () => {
        expect(service.defaultConfig().rustdeskVersion).toBe('1.4.9');
        expect(service.defaultConfig().androidAppId).toBe('com.carriez.flutter_hbb');
        expect(service.defaultConfig().macosBundleId).toBe('com.carriez.flutterHbb');
    });

    test('keeps Android and macOS application identities separate', () => {
        const valid = service.normalizeConfig(validConfig({
            target: 'macos-arm64-dmg',
            androidAppId: 'com.example.support_app',
            macosBundleId: 'com.example.Support-App',
        }));
        expect(valid.valid).toBe(true);
        expect(valid.normalized.androidAppId).toBe('com.example.support_app');
        expect(valid.normalized.macosBundleId).toBe('com.example.Support-App');

        const invalid = service.normalizeConfig(validConfig({
            target: 'macos-arm64-dmg',
            macosBundleId: 'com.example.support_app',
        }));
        expect(invalid.valid).toBe(false);
        expect(invalid.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'macosBundleId', code: 'invalid_macos_bundle_id' }),
        ]));

        const unsafeXcodeText = service.normalizeConfig(validConfig({
            target: 'macos-x64-dmg',
            appName: 'Support #1',
            companyName: 'Example $ Group',
        }));
        expect(unsafeXcodeText.valid).toBe(false);
        expect(unsafeXcodeText.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'appName', code: 'invalid_macos_branding' }),
            expect.objectContaining({ field: 'companyName', code: 'invalid_macos_branding' }),
        ]));
    });

    test('rejects MSI display branding that the pinned WiX preprocessor cannot encode safely', () => {
        const result = service.normalizeConfig(validConfig({
            target: 'windows-x64-msi',
            appName: 'Support & Control',
        }));
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'appName', code: 'invalid_msi_branding' }),
        ]));
    });

    test('derives a distinct QuickSupport build without mutating the saved configuration', () => {
        const saved = validConfig({
            target: 'windows-x64-exe',
            appName: 'Acme Support',
            executableName: 'acme-client',
            direction: 'both',
            hideConnectionManager: true,
            disableInstallation: false,
            assets: { icon: '11111111-1111-4111-8111-111111111111', logo: '22222222-2222-4222-8222-222222222222', privacy: null },
        });
        const original = JSON.parse(JSON.stringify(saved));
        const derived = service.deriveConfigForBuild(saved, {
            targetId: 'windows-x64-exe',
            variantId: 'quicksupport',
        });

        expect(derived.variant.id).toBe('quicksupport');
        expect(derived.config).toEqual(expect.objectContaining({
            target: 'windows-x64-exe',
            direction: 'incoming',
            disableInstallation: true,
            hideConnectionManager: false,
            appName: 'Acme Support QuickSupport',
            executableName: 'acme-client-quicksupport',
        }));
        expect(derived.config.assets).toEqual(saved.assets);
        expect(saved).toEqual(original);
    });

    test('keeps Android QuickSupport explicitly installable while applying the incoming-only profile', () => {
        const derived = service.deriveConfigForBuild(validConfig({ disableInstallation: true }), {
            targetId: 'android-arm64-apk',
            variantId: 'quicksupport',
        });
        expect(derived.config.direction).toBe('incoming');
        expect(derived.config.disableInstallation).toBe(false);
        expect(derived.adjustments).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'android_quicksupport_installable' }),
        ]));
        expect(service.normalizeConfig(derived.config).valid).toBe(true);
    });

    test('normalizes a complete config without public fallback values', () => {
        const result = service.normalizeConfig(validConfig({
            defaultSettings: 'custom-key=value\ncustom-second=N',
            githubToken: 'must-not-survive',
        }));
        expect(result.valid).toBe(true);
        expect(result.normalized.defaultSettings).toEqual({ 'custom-key': 'value', 'custom-second': 'N' });
        expect(result.normalized.githubToken).toBeUndefined();
        expect(JSON.stringify(result.normalized)).not.toContain('must-not-survive');
        expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'secret_not_saved' })]));
    });

    test('preserves exact independent server ports and legitimate UTF-8 branding', () => {
        const result = service.normalizeConfig(validConfig({
            idServer: 'id.example.com:443',
            relayServer: 'relay.example.com:443',
            appName: 'Podpora «Živé» 支援 e\u0301',
            companyName: 'Spoločnosť & partneri — 東京',
        }));
        expect(result.valid).toBe(true);
        expect(result.normalized.appName).toBe('Podpora «Živé» 支援 é');
        const compiled = service.compileRustDeskConfig(result.normalized);
        expect(compiled.host).toBe('id.example.com:443');
        expect(compiled.relay).toBe('relay.example.com:443');
        expect(compiled.custom['override-settings']['custom-rendezvous-server']).toBe('id.example.com:443');
        expect(compiled.custom['override-settings']['relay-server']).toBe('relay.example.com:443');
    });

    test('rejects control and bidirectional override characters in branding', () => {
        const result = service.normalizeConfig(validConfig({
            appName: 'Support\u202eexe',
            companyName: 'Company\u0007',
        }));
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'appName', code: 'invalid_branding_text' }),
            expect.objectContaining({ field: 'companyName', code: 'invalid_branding_text' }),
        ]));
    });

    test('rejects a malformed UUID-shaped asset reference', () => {
        const result = service.normalizeConfig(validConfig({
            assets: { icon: '------------------------------------' },
        }));
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'assets.icon', code: 'invalid_asset' }),
        ]));
    });

    test('rejects missing server identity instead of silently selecting RDGen defaults', () => {
        const result = service.normalizeConfig(service.defaultConfig());
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'idServer', code: 'required' }),
            expect.objectContaining({ field: 'publicKey', code: 'required' }),
        ]));
    });

    test('retains cross-platform settings but explicitly adjusts incompatible Android output values', () => {
        const result = service.normalizeConfig(validConfig({ target: 'android-arm64-apk', disableInstallation: true }));
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'disableInstallation', code: 'platform_limited' }),
        ]));

        const privacy = '33333333-3333-4333-8333-333333333333';
        const saved = validConfig({
            target: 'windows-x64-exe',
            disableInstallation: true,
            hideConnectionManager: true,
            approvalMode: 'password',
            assets: { icon: null, logo: null, privacy },
        });
        const derived = service.deriveConfigForBuild(saved, {
            targetId: 'android-arm64-apk',
            variantId: 'client',
        });
        expect(derived.config).toEqual(expect.objectContaining({
            disableInstallation: false,
            hideConnectionManager: false,
            assets: expect.objectContaining({ privacy: null }),
        }));
        expect(derived.adjustments).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'android_installation_required' }),
            expect.objectContaining({ code: 'hide_connection_manager_omitted' }),
            expect.objectContaining({ code: 'privacy_asset_omitted' }),
        ]));
        expect(service.normalizeConfig(derived.config).valid).toBe(true);
        expect(saved.assets.privacy).toBe(privacy);
    });

    test('rejects hide-connection-manager unless password approval is selected', () => {
        const invalid = service.normalizeConfig(validConfig({
            hideConnectionManager: true,
            approvalMode: 'password-click',
        }));
        expect(invalid.valid).toBe(false);
        expect(invalid.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'hideConnectionManager', code: 'incompatible' }),
        ]));

        const valid = service.normalizeConfig(validConfig({
            hideConnectionManager: true,
            approvalMode: 'password',
        }));
        expect(valid.valid).toBe(true);
    });

    test('rejects secrets disguised as persistent manual settings', () => {
        const result = service.normalizeConfig(validConfig({ overrideSettings: 'operator-password=must-not-be-saved' }));
        expect(result.valid).toBe(false);
        expect(result.normalized.overrideSettings).not.toHaveProperty('operator-password');
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'overrideSettings', code: 'secret_setting_forbidden' }),
        ]));
    });

    test('rejects manual settings that would override validated generator policy', () => {
        const result = service.normalizeConfig(validConfig({
            defaultSettings: 'enable-audio=N',
            overrideSettings: { 'custom-rendezvous-server': 'different.example.com:443' },
        }));
        expect(result.valid).toBe(false);
        expect(result.normalized.defaultSettings).not.toHaveProperty('enable-audio');
        expect(result.normalized.overrideSettings).not.toHaveProperty('custom-rendezvous-server');
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'defaultSettings', code: 'managed_setting_conflict' }),
            expect.objectContaining({ field: 'overrideSettings', code: 'managed_setting_conflict' }),
        ]));
    });

    test('rejects control characters in persistent manual setting values', () => {
        const result = service.normalizeConfig(validConfig({
            defaultSettings: { 'custom-value': 'safe\u202eexe' },
        }));
        expect(result.valid).toBe(false);
        expect(result.normalized.defaultSettings).not.toHaveProperty('custom-value');
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'defaultSettings', code: 'invalid_setting_value' }),
        ]));
    });

    test('rejects credential-bearing or executable URL schemes', () => {
        const result = service.normalizeConfig(validConfig({
            apiServer: 'https://user:secret@api.example.com',
            customUrl: 'javascript://example.com/alert',
        }));
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'apiServer', code: 'invalid_endpoint' }),
            expect.objectContaining({ field: 'customUrl', code: 'invalid_endpoint' }),
        ]));
    });

    test('rejects API query credentials while preserving ordinary branded links', () => {
        const result = service.normalizeConfig(validConfig({
            apiServer: 'https://api.example.com/base?token=must-not-be-saved#session',
            customUrl: 'https://www.example.com/support?language=sk#download',
        }));
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'apiServer', code: 'invalid_endpoint' }),
        ]));
        expect(result.normalized.customUrl).toBe('https://www.example.com/support?language=sk#download');
    });

    test('requires a target to be verified by the selected provider when building', () => {
        const result = service.normalizeConfig(validConfig(), { availableTargetIds: new Set(['linux-x64-deb']) });
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'target_not_configured' })]));
    });

    test('requires the exact RustDesk revision to be E2E-verified by the provider', () => {
        const result = service.normalizeConfig(validConfig({ rustdeskVersion: 'master' }), {
            availableRustDeskVersions: new Set(['1.4.9']),
            availableBuildCombinations: new Set(['windows-x64-exe@1.4.9']),
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'rustdeskVersion', code: 'version_not_configured' }),
            expect.objectContaining({ field: 'target', code: 'combination_not_configured' }),
        ]));
    });

    test('does not treat independent verified targets and versions as a verified pair', () => {
        const result = service.normalizeConfig(validConfig({ rustdeskVersion: '1.4.9', target: 'windows-x64-exe' }), {
            availableTargetIds: new Set(['windows-x64-exe', 'linux-x64-deb']),
            availableRustDeskVersions: new Set(['1.4.9', 'master']),
            availableBuildCombinations: new Set(['windows-x64-exe@master', 'linux-x64-deb@1.4.9']),
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'target', code: 'combination_not_configured' }),
        ]));
        expect(result.errors).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'version_not_configured' }),
        ]));
    });

    test('rejects oversized values instead of silently saving truncated configuration', () => {
        const settings = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`custom-${index}`, 'Y']));
        const result = service.normalizeConfig(validConfig({
            appName: 'A'.repeat(65),
            idServer: 'a'.repeat(513),
            defaultSettings: settings,
            overrideSettings: { custom: 'x'.repeat(501) },
        }));

        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'appName', code: 'too_long' }),
            expect.objectContaining({ field: 'idServer', code: 'too_long' }),
            expect.objectContaining({ field: 'defaultSettings', code: 'too_many_settings' }),
            expect.objectContaining({ field: 'overrideSettings', code: 'too_long' }),
        ]));
    });

    test('compiles RDGen-compatible RustDesk settings and isolates one-time password', () => {
        const config = service.normalizeConfig(validConfig({ approvalMode: 'password', direction: 'incoming' })).normalized;
        const compiled = service.compileRustDeskConfig(config, { permanentPassword: 'one-time-secret' });
        expect(compiled.host).toBe('id.example.com:21116');
        expect(compiled.custom.password).toBe('one-time-secret');
        expect(compiled.custom['conn-type']).toBe('incoming');
        expect(compiled.custom['default-settings']['enable-file-transfer']).toBe('Y');
        expect(compiled.custom['default-settings']['allow-remote-config-modification']).toBe('N');
        expect(compiled.custom['default-settings']['approve-mode']).toBe('password');
        expect(compiled.custom['override-settings']['custom-rendezvous-server']).toBe('id.example.com:21116');
        expect(compiled.custom['override-settings']['relay-server']).toBe('relay.example.com:21117');
        expect(config.permanentPassword).toBeUndefined();
    });

    test('uses RustDesk native signed settings for cycle-monitor controls', () => {
        const config = service.normalizeConfig(validConfig({ cycleMonitor: true })).normalized;
        const compiled = service.compileRustDeskConfig(config);
        expect(compiled.custom['default-settings']).toEqual(expect.objectContaining({
            'allow-monitor-switch-main-toolbar': 'Y',
            'allow-monitor-switch-min-toolbar': 'Y',
        }));
    });
});
