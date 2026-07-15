'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const SOURCE_COMMIT = '7d06de00fb29fcc2cfc93a722a1fe506923b1f74';

describe('central Real Client build-repository scripts', () => {
    let root;

    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-real-client-scripts-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function sourcePatchPlan(overrides = {}) {
        return {
            connectionDelay: 'disabled',
            cycleMonitor: 'disabled',
            offlineIndicator: 'disabled',
            hideConnectionManager: 'disabled',
            removeVersionNotification: 'disabled',
            customConfigVerification: 'ed25519-required',
            ...overrides,
        };
    }

    function validPayload(overrides = {}) {
        const configuration = {
            rustdeskVersion: '1.4.4',
            target: 'windows-x64-exe',
            idServer: 'id.example.com:443',
            relayServer: 'relay.example.com:443',
            apiServer: 'https://api.example.com',
            publicKey: Buffer.alloc(32, 7).toString('base64'),
            appName: '支援 «Desk» \' ` ~',
            executableName: 'support-client',
            companyName: 'Živé služby, s.r.o.',
            customUrl: '',
            downloadUrl: '',
            androidAppId: 'com.example.support',
            macosBundleId: 'com.example.support',
            delayFix: true,
            cycleMonitor: false,
            offlineIndicator: true,
            removeVersionNotification: false,
            ...(overrides.configuration || {}),
        };
        return {
            schema: 'betterdesk-real-client-build/v1',
            build: {
                id: '66666666-6666-4666-8666-666666666666',
                batchId: '77777777-7777-4777-8777-777777777777',
                clientVariant: 'quicksupport',
                target: 'windows-x64-exe',
                platform: 'windows',
                arch: 'x86_64',
                package: 'exe',
                rustdeskVersion: '1.4.4',
                sourceCommit: SOURCE_COMMIT,
                ...(overrides.build || {}),
            },
            configuration,
            rustdeskCustomConfig: {
                host: configuration.idServer,
                relay: configuration.relayServer,
                key: configuration.publicKey,
                custom: { password: 'one-time-secret' },
            },
            assets: {},
        };
    }

    test('signs custom config and replaces only the embedded verifier key', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'src', 'common.rs'), `
pub fn read_custom_client(config: &str) {
    const KEY: &str = "5Qbwsde3unUcJBtrx9ZkvUmwFNoExHzpryHuPUdqlWM=";
    let Ok(data) = sign::verify(&data, &pk) else { return; };
}
`);
        const custom = { 'conn-type': 'incoming', 'default-settings': { 'enable-keyboard': 'Y' }, 'override-settings': {} };
        fs.writeFileSync(path.join(inputDir, 'custom-config.json'), JSON.stringify({ custom }));
        const keys = crypto.generateKeyPairSync('ed25519');
        const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/sign-custom-config.mjs');
        const output = path.join(inputDir, 'custom_.txt');
        const run = spawnSync(process.execPath, [script, path.join(inputDir, 'custom-config.json'), output, sourceDir], {
            env: { ...process.env, REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY: privatePem }, encoding: 'utf8',
        });
        expect(run.status).toBe(0);
        const signed = Buffer.from(fs.readFileSync(output, 'utf8'), 'base64');
        expect(crypto.verify(null, signed.subarray(64), keys.publicKey, signed.subarray(0, 64))).toBe(true);
        expect(JSON.parse(signed.subarray(64).toString('utf8'))).toEqual(custom);
        const patched = fs.readFileSync(path.join(sourceDir, 'src', 'common.rs'), 'utf8');
        const rawPublic = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
        expect(patched).toContain(`const KEY: &str = "${rawPublic}";`);
        expect(patched).toContain('sign::verify');
    });

    test('output validator rejects extra or wrong-package artifacts', () => {
        const out = path.join(root, 'out');
        fs.mkdirSync(out);
        fs.writeFileSync(path.join(out, 'client.exe'), 'binary');
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/validate-output.mjs');
        expect(spawnSync(process.execPath, [script, 'windows-x64-exe', out]).status).toBe(0);
        fs.writeFileSync(path.join(out, 'extra.txt'), 'unexpected');
        expect(spawnSync(process.execPath, [script, 'windows-x64-exe', out]).status).not.toBe(0);
    });

    test('keeps the current RDGen Linux ARM64 Flatpak target in both input and output contracts', () => {
        const extractor = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/extract-build-input.mjs'), 'utf8');
        const validator = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/validate-output.mjs'), 'utf8');
        const targets = require('../services/realClientConfigService').TARGETS;
        expect(targets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'linux-arm64-flatpak', arch: 'aarch64', package: 'flatpak' }),
        ]));
        expect(extractor).toContain("'linux-arm64-flatpak'");
        expect(validator).toContain("'linux-arm64-flatpak': '.flatpak'");
    });

    test('input and output contracts agree for every declared target', () => {
        const targets = require('../services/realClientConfigService').TARGETS;
        const extractor = path.resolve(__dirname, '../../docs/real-client-build-repository/extract-build-input.mjs');
        const validator = path.resolve(__dirname, '../../docs/real-client-build-repository/validate-output.mjs');
        const extension = {
            exe: 'exe', msi: 'msi', deb: 'deb', appimage: 'AppImage', flatpak: 'flatpak', apk: 'apk', dmg: 'dmg',
        };
        for (const target of targets) {
            const fixtureRoot = path.join(root, target.id);
            const payloadPath = path.join(fixtureRoot, 'payload.json');
            const inputDir = path.join(fixtureRoot, 'input');
            const outputDir = path.join(fixtureRoot, 'out');
            fs.mkdirSync(fixtureRoot, { recursive: true });
            fs.writeFileSync(payloadPath, JSON.stringify(validPayload({
                build: {
                    target: target.id,
                    platform: target.platform,
                    arch: target.arch,
                    package: target.package,
                },
                configuration: { target: target.id },
            })));
            const extraction = spawnSync(process.execPath, [extractor, payloadPath, inputDir], { encoding: 'utf8' });
            expect({ target: target.id, status: extraction.status, stderr: extraction.stderr }).toEqual({
                target: target.id, status: 0, stderr: '',
            });
            const plan = JSON.parse(fs.readFileSync(path.join(inputDir, 'build-plan.json'), 'utf8'));
            expect(plan).toEqual(expect.objectContaining({
                target: target.id,
                platform: target.platform,
                arch: target.arch,
                package: target.package,
                sourceCommit: SOURCE_COMMIT,
            }));

            fs.mkdirSync(outputDir);
            fs.writeFileSync(path.join(outputDir, `client.${extension[target.package]}`), 'non-empty artifact fixture');
            const validation = spawnSync(process.execPath, [validator, target.id, outputDir], { encoding: 'utf8' });
            expect({ target: target.id, status: validation.status, stderr: validation.stderr }).toEqual({
                target: target.id, status: 0, stderr: '',
            });
        }
    });

    test('concrete build adapter exposes only revision-guarded target profiles', () => {
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const run = spawnSync(process.execPath, [script, '--describe'], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        const contract = JSON.parse(run.stdout);
        expect(contract).toEqual(expect.objectContaining({
            schema: 'betterdesk-real-client-adapter/v1',
            sourceRevisions: { '1.4.9': '6c578292e8ebbbec708b76986ba8c4bc7c509747' },
            vendorRevisions: {
                privacyHelper: '53b548a5398624f7149a382000397993542ad796',
                flatpakSharedModules: '7b858d89ffe3bf9ce6e0390fe72691c9c5f322d3',
            },
        }));
        expect(contract.targets).toHaveLength(14);
        expect(contract.targets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'windows-x64-exe', implementedByAdapter: true }),
            expect.objectContaining({ id: 'linux-arm64-flatpak', implementedByAdapter: true }),
            expect.objectContaining({ id: 'android-arm64-apk', implementedByAdapter: true }),
            expect.objectContaining({ id: 'macos-arm64-dmg', implementedByAdapter: true }),
            expect.objectContaining({ id: 'windows-x86-exe', implementedByAdapter: false }),
        ]));
    });

    test('build adapter applies UTF-8 branding with exact file transforms and no shell interpolation', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'libs/portable'), { recursive: true });
        fs.mkdirSync(path.join(sourceDir, 'flutter/lib/desktop/pages'), { recursive: true });
        fs.mkdirSync(path.join(sourceDir, 'flutter/lib/models'), { recursive: true });
        fs.mkdirSync(path.join(sourceDir, 'flutter/assets'), { recursive: true });
        fs.mkdirSync(path.join(sourceDir, 'res'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        const cargo = [
            'description = "RustDesk Remote Desktop"',
            'LegalCopyright = "Copyright © 2026 Purslane Tech Pte. Ltd. All rights reserved."',
            'ProductName = "RustDesk"',
            'FileDescription = "RustDesk Remote Desktop"',
            'OriginalFilename = "rustdesk.exe"',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(sourceDir, 'Cargo.toml'), cargo);
        fs.writeFileSync(path.join(sourceDir, 'libs/portable/Cargo.toml'), cargo);
        fs.writeFileSync(path.join(sourceDir, 'flutter/lib/desktop/pages/desktop_setting_page.dart'),
            "'Copyright © ${DateTime.now().toString().substring(0, 4)} Purslane Tech Pte. Ltd.\\n$license'\n");
        fs.writeFileSync(path.join(sourceDir, 'flutter/lib/models/native_model.dart'), [
            '      await _ffiBind.mainSetHomeDir(home: _homeDir);',
            '      await _ffiBind.mainInit(',
            '        appDir: _dir,',
            "        customClientConfig: '',",
            '      );',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(sourceDir, 'res/rustdesk.desktop'), 'Name=RustDesk\n');
        fs.writeFileSync(path.join(sourceDir, 'res/rustdesk-link.desktop'), 'Name=RustDesk\n');
        const plan = {
            schema: 'betterdesk-real-client-plan/v1',
            target: 'linux-x64-deb', platform: 'linux', arch: 'x86_64', package: 'deb',
            sourceRevision: '1.4.9', sourceCommit: '6c578292e8ebbbec708b76986ba8c4bc7c509747', clientVariant: 'client',
            branding: {
                appName: 'Živá Podpora', companyName: 'Firma $ & Co.', executableName: 'support-client',
                customUrl: '', downloadUrl: '', androidAppId: 'com.example.support', macosBundleId: 'com.example.support',
            },
            assets: { icon: false, logo: false, privacy: false },
            sourcePatches: { customConfigVerification: 'ed25519-required' },
        };
        const planPath = path.join(root, 'plan.json');
        fs.writeFileSync(planPath, JSON.stringify(plan));
        const signedConfig = path.join(inputDir, 'custom_.txt');
        fs.writeFileSync(signedConfig, 'A'.repeat(96));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const source = `import fs from 'node:fs/promises'; import { prepareSourceForBuild, embedSignedCustomConfig } from ${JSON.stringify(pathToFileURL(script).href)}; const plan=JSON.parse(await fs.readFile(${JSON.stringify(planPath)},'utf8')); await prepareSourceForBuild(plan,${JSON.stringify(inputDir)},${JSON.stringify(sourceDir)}); await embedSignedCustomConfig(${JSON.stringify(sourceDir)},${JSON.stringify(signedConfig)});`;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        expect(fs.readFileSync(path.join(sourceDir, 'Cargo.toml'), 'utf8')).toContain('ProductName = "Živá Podpora"');
        expect(fs.readFileSync(path.join(sourceDir, 'res/rustdesk.desktop'), 'utf8')).toContain('Name=Živá Podpora');
        const dart = fs.readFileSync(path.join(sourceDir, 'flutter/lib/desktop/pages/desktop_setting_page.dart'), 'utf8');
        expect(dart).toContain('Firma \\$ & Co.\\n$license');
        expect(fs.readFileSync(path.join(sourceDir, 'flutter/lib/models/native_model.dart'), 'utf8'))
            .toContain("rootBundle.loadString('assets/custom.txt')");
        expect(fs.readFileSync(path.join(sourceDir, 'flutter/assets/custom.txt'), 'utf8')).toBe('A'.repeat(96));
        const adapter = fs.readFileSync(script, 'utf8');
        expect(adapter).toContain('shell: false');
        expect(adapter).toContain("rootBundle.loadString('assets/custom.txt')");
        expect(adapter).toContain("path.join(release, 'custom.txt')");
        expect(adapter).toContain("Contents/Resources/custom.txt");
        expect(adapter).not.toMatch(/execSync|shell:\s*true/);
    });

    test('payload decryptor fails closed without an exact trusted HTTPS origin and build path', () => {
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/decrypt-payload.mjs');
        const source = fs.readFileSync(script, 'utf8');
        expect(source).toContain('AbortSignal.timeout(180000)');
        const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
        const buildId = '66666666-6666-4666-8666-666666666666';
        const baseEnv = { ...process.env, REAL_CLIENT_PAYLOAD_PRIVATE_KEY: privatePem };

        const missingOrigin = spawnSync(process.execPath, [script,
            `https://console.example.com/api/generator/real-client/payload/${buildId}`, buildId,
        ], { env: baseEnv, encoding: 'utf8' });
        expect(missingOrigin.status).not.toBe(0);
        expect(missingOrigin.stderr).toContain('trusted origin');

        const wrongPath = spawnSync(process.execPath, [script,
            `https://console.example.com/api/other/${buildId}`, buildId,
        ], { env: { ...baseEnv, BETTERDESK_PAYLOAD_ORIGIN: 'https://console.example.com' }, encoding: 'utf8' });
        expect(wrongPath.status).not.toBe(0);
        expect(wrongPath.stderr).toContain('path does not match');
    });

    test('extracts exact independent ports and UTF-8 branding into a non-secret build plan', () => {
        const payloadPath = path.join(root, 'payload.json');
        const outputDir = path.join(root, 'input');
        fs.writeFileSync(payloadPath, JSON.stringify(validPayload()));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/extract-build-input.mjs');
        const run = spawnSync(process.execPath, [script, payloadPath, outputDir], { encoding: 'utf8' });

        expect(run.status).toBe(0);
        const planText = fs.readFileSync(path.join(outputDir, 'build-plan.json'), 'utf8');
        const plan = JSON.parse(planText);
        expect(plan.batchId).toBe('77777777-7777-4777-8777-777777777777');
        expect(plan.clientVariant).toBe('quicksupport');
        expect(plan.sourceCommit).toBe(SOURCE_COMMIT);
        expect(plan.network.id).toEqual(expect.objectContaining({ address: 'id.example.com:443', port: 443 }));
        expect(plan.network.relay).toEqual(expect.objectContaining({ address: 'relay.example.com:443', port: 443 }));
        expect(plan.branding.appName).toBe('支援 «Desk» \' ` ~');
        expect(plan.branding.companyName).toBe('Živé služby, s.r.o.');
        expect(plan.branding.androidAppId).toBe('com.example.support');
        expect(plan.branding.macosBundleId).toBe('com.example.support');
        expect(plan.sourcePatches).toEqual(expect.objectContaining({
            connectionDelay: 'revision-guarded',
            offlineIndicator: 'revision-guarded',
            hideConnectionManager: 'disabled',
            customConfigVerification: 'ed25519-required',
        }));
        expect(planText).not.toContain('one-time-secret');
        expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'custom-config.json'), 'utf8')).custom.password)
            .toBe('one-time-secret');
    });

    test('Linux ARM64 compatibility uses the pinned Flutter-elinux command and native package path exactly once', () => {
        const sourceDir = path.join(root, 'source');
        fs.mkdirSync(sourceDir);
        fs.writeFileSync(path.join(sourceDir, 'build.py'), [
            "flutter_build_dir = 'build/linux/x64/release/bundle/'",
            '',
            'def build_flutter_deb(version, features):',
            "    os.chdir('flutter')",
            "    system2('flutter build linux --release')",
            "    system2('mkdir -p tmpdeb/usr/bin/')",
            '',
        ].join('\n'));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const source = `import {applyPlatformBuildCompatibility} from ${JSON.stringify(pathToFileURL(script).href)}; await applyPlatformBuildCompatibility({platform:'linux',arch:'aarch64'},${JSON.stringify(sourceDir)});`;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        expect(fs.readFileSync(path.join(sourceDir, 'build.py'), 'utf8')).toBe([
            "flutter_build_dir = 'build/linux/arm64/release/bundle/'",
            '',
            'def build_flutter_deb(version, features):',
            "    os.chdir('flutter')",
            "    system2('flutter-elinux build linux --verbose')",
            "    system2('mkdir -p tmpdeb/usr/bin/')",
            '',
        ].join('\n'));
        const second = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        expect(second.status).not.toBe(0);
        expect(second.stderr).toContain('expected 1 exact source marker(s), found 0');
    });

    test('Windows MSI keeps the executable identity separate from the visible product name', () => {
        const sourceDir = path.join(root, 'source');
        const packageDir = path.join(sourceDir, 'res/msi/Package');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'res/msi/preprocess.py'), `
def make_parser():
    parser.add_argument(
        "--app-name", type=str, default="RustDesk", help="The app name."
    )

def gen_pre_vars(args):
    values = [
            f'{indent}<?define Product="{args.app_name}" ?>\\n',
            f'{indent}<?define Description="{args.app_name} Installer" ?>\\n',
    ]

def registry(args):
    return f'{indent}<RegistryValue Type="string" Name="DisplayName" Value="{args.app_name}" />\\n'

if __name__ == "__main__":
    app_name = args.app_name
    dist_dir = Path(sys.argv[0]).parent.joinpath(args.dist_dir).resolve()
    update_license_file(app_name)
    replace_app_name_in_langs(args.app_name)
    replace_app_name_in_custom_actions(args.app_name)
`);
        fs.writeFileSync(path.join(packageDir, 'Package.wxs'), '<Package Name="$(var.Product)" Version="$(var.Version)" />\n');
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const plan = {
            platform: 'windows', package: 'msi',
            branding: { executableName: 'support-client', appName: 'Živá Podpora', companyName: 'Firma, s.r.o.' },
        };
        const source = `import {prepareWindowsMsiSources} from ${JSON.stringify(pathToFileURL(script).href)}; await prepareWindowsMsiSources(${JSON.stringify(plan)},${JSON.stringify(sourceDir)});`;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        const patched = fs.readFileSync(path.join(sourceDir, 'res/msi/preprocess.py'), 'utf8');
        expect(patched).toContain('"--display-name"');
        expect(patched).toContain('<?define Product="{args.app_name}" ?>');
        expect(patched).toContain('<?define DisplayName="{args.display_name}" ?>');
        expect(patched).toContain('update_license_file(args.display_name)');
        expect(patched).toContain('replace_app_name_in_custom_actions(args.app_name)');
        expect(fs.readFileSync(path.join(packageDir, 'Package.wxs'), 'utf8'))
            .toContain('<Package Name="$(var.DisplayName)"');
        const second = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        expect(second.status).not.toBe(0);
    });

    test('input extractor rejects unsafe branding and mismatched target metadata', () => {
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/extract-build-input.mjs');
        const unsafePayload = path.join(root, 'unsafe.json');
        fs.writeFileSync(unsafePayload, JSON.stringify(validPayload({ configuration: { appName: 'Desk\u202eexe' } })));
        const unsafe = spawnSync(process.execPath, [script, unsafePayload, path.join(root, 'unsafe-input')], { encoding: 'utf8' });
        expect(unsafe.status).not.toBe(0);
        expect(unsafe.stderr).toContain('configuration.appName contains invalid text');

        const mismatchPayload = path.join(root, 'mismatch.json');
        fs.writeFileSync(mismatchPayload, JSON.stringify(validPayload({ build: { platform: 'linux' } })));
        const mismatch = spawnSync(process.execPath, [script, mismatchPayload, path.join(root, 'mismatch-input')], { encoding: 'utf8' });
        expect(mismatch.status).not.toBe(0);
        expect(mismatch.stderr).toContain('target metadata does not match');
    });

    test('input extractor rejects API URLs that could persist query credentials', () => {
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/extract-build-input.mjs');
        const payloadPath = path.join(root, 'api-query.json');
        fs.writeFileSync(payloadPath, JSON.stringify(validPayload({
            configuration: { apiServer: 'https://api.example.com/base?token=must-not-be-saved#session' },
        })));
        const run = spawnSync(process.execPath, [script, payloadPath, path.join(root, 'api-query-input')], { encoding: 'utf8' });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain('without credentials, query or fragment');
    });

    test('Android signing properties preserve complex secrets without line injection', () => {
        const sourceDir = path.join(root, 'android-source');
        const secretRoot = path.join(root, 'android-secrets');
        fs.mkdirSync(path.join(sourceDir, 'flutter/android'), { recursive: true });
        const adapter = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const source = `import fs from 'node:fs/promises'; import {prepareAndroidSigning} from ${JSON.stringify(pathToFileURL(adapter).href)}; const dir=await prepareAndroidSigning(${JSON.stringify(sourceDir)},${JSON.stringify(secretRoot)}); if(!dir.startsWith(${JSON.stringify(`${secretRoot}${path.sep}`)})) process.exit(2); const value=await fs.readFile(${JSON.stringify(path.join(sourceDir, 'flutter/android/key.properties'))},'ascii'); process.stdout.write(value); await fs.rm(${JSON.stringify(path.join(sourceDir, 'flutter/android/key.properties'))},{force:true}); await fs.rm(dir,{recursive:true,force:true});`;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
            encoding: 'utf8',
            env: {
                ...process.env,
                REAL_CLIENT_ANDROID_KEYSTORE_BASE64: Buffer.from('keystore-fixture').toString('base64'),
                REAL_CLIENT_ANDROID_STORE_PASSWORD: 'line1\nline2',
                REAL_CLIENT_ANDROID_KEY_ALIAS: 'release:key',
                REAL_CLIENT_ANDROID_KEY_PASSWORD: 'päss#!',
            },
        });
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        expect(run.stdout).toMatch(/^storePassword=line1\\nline2\n/);
        expect(run.stdout).toContain('keyPassword=p\\u00e4ss\\#\\!\n');
        expect(run.stdout).toContain('keyAlias=release\\:key\n');
        expect(run.stdout).not.toContain('line1\nline2');
    });

    test('Android artifact admission requires the configured signing-certificate fingerprint', async () => {
        const adapter = path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs');
        const expected = 'A1'.repeat(32);
        const source = `
            import {verifyAndroidSignerOutput} from ${JSON.stringify(pathToFileURL(adapter).href)};
            const expected = ${JSON.stringify(expected)};
            const result = verifyAndroidSignerOutput(
                \`Signer #1 certificate SHA-256 digest: \${expected.toLowerCase()}\`,
                expected.match(/../g).join(':'),
            );
            const errors = [];
            for (const [output, fingerprint] of [
                [\`Signer #1 certificate SHA-256 digest: \${'B2'.repeat(32)}\`, expected],
                ['', 'invalid'],
            ]) {
                try { verifyAndroidSignerOutput(output, fingerprint); }
                catch (error) { errors.push(error.message); }
            }
            process.stdout.write(JSON.stringify({ result, errors }));
        `;
        const run = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
            encoding: 'utf8',
        });
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        expect(JSON.parse(run.stdout)).toEqual({
            result: expected,
            errors: [
                'Android APK signer does not match the configured certificate fingerprint',
                'Android signing certificate SHA-256 fingerprint is invalid',
            ],
        });
    });

    test('custom-config signer refuses to replace a verifier key outside read_custom_client', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'src', 'common.rs'), `
pub fn read_custom_client(config: &str) {
    let _ = config;
}
pub fn unrelated() {
    const KEY: &str = "5Qbwsde3unUcJBtrx9ZkvUmwFNoExHzpryHuPUdqlWM=";
}
`);
        fs.writeFileSync(path.join(inputDir, 'custom-config.json'), JSON.stringify({ custom: {} }));
        const keys = crypto.generateKeyPairSync('ed25519');
        const run = spawnSync(process.execPath, [
            path.resolve(__dirname, '../../docs/real-client-build-repository/sign-custom-config.mjs'),
            path.join(inputDir, 'custom-config.json'), path.join(inputDir, 'custom_.txt'), sourceDir,
        ], {
            env: { ...process.env, REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
            encoding: 'utf8',
        });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain('found 0');
    });

    test('custom-config signer refuses an unapproved embedded verification key', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'src', 'common.rs'), `
pub fn read_custom_client(config: &str) {
    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let Ok(data) = sign::verify(&data, &pk) else { return; };
}
`);
        fs.writeFileSync(path.join(inputDir, 'custom-config.json'), JSON.stringify({ custom: {} }));
        const keys = crypto.generateKeyPairSync('ed25519');
        const run = spawnSync(process.execPath, [
            path.resolve(__dirname, '../../docs/real-client-build-repository/sign-custom-config.mjs'),
            path.join(inputDir, 'custom-config.json'), path.join(inputDir, 'custom_.txt'), sourceDir,
        ], {
            env: { ...process.env, REAL_CLIENT_CUSTOM_CONFIG_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
            encoding: 'utf8',
        });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain('not the approved upstream key');
    });

    test('connection-delay workaround replaces exactly one revision-guarded source hunk', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'src', 'client.rs'), `
fn connect(key: &str) {
    if is_local || peer_nat_type == NatType::SYMMETRIC {
        connect_direct();
    }
    if !key.is_empty() { preserve_encryption(); }
}
`);
        fs.writeFileSync(path.join(inputDir, 'build-plan.json'), JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourcePatches: sourcePatchPlan({ connectionDelay: 'revision-guarded' }),
        }));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/apply-source-patches.mjs');
        const run = spawnSync(process.execPath, [script, path.join(inputDir, 'build-plan.json'), sourceDir], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        const patched = fs.readFileSync(path.join(sourceDir, 'src', 'client.rs'), 'utf8');
        expect(patched).toContain('peer_nat_type == NatType::SYMMETRIC || !key.is_empty() {');
        expect(patched).toContain('if !key.is_empty() { preserve_encryption(); }');

        // The operation is intentionally idempotent for a retried workflow.
        expect(spawnSync(process.execPath, [script, path.join(inputDir, 'build-plan.json'), sourceDir]).status).toBe(0);
    });

    test('connection-delay workaround fails closed on an unknown source revision', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'src', 'client.rs'), 'fn changed_upstream() {}\n');
        fs.writeFileSync(path.join(inputDir, 'build-plan.json'), JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourcePatches: sourcePatchPlan({ connectionDelay: 'revision-guarded' }),
        }));
        const run = spawnSync(process.execPath, [
            path.resolve(__dirname, '../../docs/real-client-build-repository/apply-source-patches.mjs'),
            path.join(inputDir, 'build-plan.json'), sourceDir,
        ], { encoding: 'utf8' });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain('incompatible with this RustDesk revision');
    });

    test('applies all requested UI feature policies exactly once and preserves system diagnostics', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        const writeSource = (relative, value) => {
            const destination = path.join(sourceDir, relative);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, value);
        };
        fs.mkdirSync(inputDir, { recursive: true });
        writeSource('flutter/lib/common/widgets/peer_card.dart', `
          child: CircleAvatar(
              radius: 3, backgroundColor: online ? Colors.green : kColorWarn)))
`);
        writeSource('flutter/lib/desktop/widgets/remote_toolbar.dart', `
          pi.displaysCount.value > 1 &&
          mainGetLocalBoolOptionSync(kOptionAllowMonitorSwitchMainToolbar)) {
        return _MainMonitorSwitchButton(id: widget.id, ffi: widget.ffi);
class _MinimizedMonitorSwitchButton extends StatelessWidget {
`);
        writeSource('flutter/lib/desktop/pages/desktop_setting_page.dart', `
            // if (usePassword)
            //   hide_cm(!locked).marginOnly(left: _kContentHSubMargin - 6),
`);
        writeSource('flutter/lib/main.dart', `
  gFFI.serverModel.hideCm = hide;
`);
        writeSource('flutter/lib/models/server_model.dart', `
  bool hideCm = false;
  bool get clipboardOk => _clipboardOk;

  bool get showElevation => _showElevation;
    /*
    if (method != kUsePermanentPassword) {
      await bind.mainSetOption(
          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));
    }
    */
    /*
    if (mode != 'password') {
      await bind.mainSetOption(
          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));
    }
    */
    /*
    // initital _hideCm at startup
    final verificationMethod =
        bind.mainGetOptionSync(key: kOptionVerificationMethod);
    final approveMode = bind.mainGetOptionSync(key: kOptionApproveMode);
    _hideCm = option2bool(
        'allow-hide-cm', bind.mainGetOptionSync(key: 'allow-hide-cm'));
    if (!(approveMode == 'password' &&
        verificationMethod == kUsePermanentPassword)) {
      _hideCm = false;
    }
    */
    /*
    var hideCm = option2bool(
        'allow-hide-cm', await bind.mainGetOption(key: 'allow-hide-cm'));
    if (!(approveMode == 'password' &&
        verificationMethod == kUsePermanentPassword)) {
      hideCm = false;
    }
    */
    /*
    if (_hideCm != hideCm) {
      _hideCm = hideCm;
      if (desktopType == DesktopType.cm) {
        if (hideCm) {
          await hideCmWindow();
        } else {
          await showCmWindow();
        }
      }
      update = true;
    }
    */
`);
        writeSource('flutter/lib/desktop/pages/desktop_home_page.dart', `
    if (!bind.isCustomClient() &&
        updateUrl.isNotEmpty &&
        !isCardClosed) {
      return updateCard();
    }
    if (systemError.isNotEmpty) return systemErrorCard();
`);
        const planPath = path.join(inputDir, 'build-plan.json');
        fs.writeFileSync(planPath, JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourcePatches: sourcePatchPlan({
                cycleMonitor: 'native-toolbar-setting',
                offlineIndicator: 'revision-guarded',
                hideConnectionManager: 'revision-guarded',
                removeVersionNotification: 'custom-client-native-guard',
            }),
        }));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/apply-source-patches.mjs');
        const run = spawnSync(process.execPath, [script, planPath, sourceDir], { encoding: 'utf8' });
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        expect(fs.readFileSync(path.join(sourceDir, 'flutter/lib/common/widgets/peer_card.dart'), 'utf8'))
            .toContain('Icon(Icons.close, color: Colors.red, size: 12.0)');
        const model = fs.readFileSync(path.join(sourceDir, 'flutter/lib/models/server_model.dart'), 'utf8');
        expect(model).toContain('bool _hideCm = false;');
        expect(model).toContain('bool get hideCm => _hideCm;');
        expect(model).not.toContain('/*\n    if (_hideCm != hideCm)');
        const home = fs.readFileSync(path.join(sourceDir, 'flutter/lib/desktop/pages/desktop_home_page.dart'), 'utf8');
        expect(home).toContain('!bind.isCustomClient()');
        expect(home).toContain('systemErrorCard()');

        // Retried workflows are idempotent and must not duplicate transforms.
        expect(spawnSync(process.execPath, [script, planPath, sourceDir]).status).toBe(0);
    });

    test('source verifier accepts only the exact clean Git commit from the build plan', () => {
        const sourceDir = path.join(root, 'source');
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.mkdirSync(inputDir, { recursive: true });
        const git = (...args) => spawnSync('git', ['-C', sourceDir, ...args], { encoding: 'utf8' });
        expect(git('init').status).toBe(0);
        expect(git('config', 'user.name', 'BetterDesk Test').status).toBe(0);
        expect(git('config', 'user.email', 'test@example.invalid').status).toBe(0);
        fs.writeFileSync(path.join(sourceDir, 'tracked.txt'), 'immutable\n');
        expect(git('add', 'tracked.txt').status).toBe(0);
        expect(git('commit', '-m', 'fixture').status).toBe(0);
        const commit = git('rev-parse', 'HEAD').stdout.trim();
        const planPath = path.join(inputDir, 'build-plan.json');
        fs.writeFileSync(planPath, JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourceCommit: commit,
        }));
        const script = path.resolve(__dirname, '../../docs/real-client-build-repository/verify-source-revision.mjs');
        expect(spawnSync(process.execPath, [script, planPath, sourceDir], { encoding: 'utf8' }).status).toBe(0);

        fs.writeFileSync(planPath, JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourceCommit: 'f'.repeat(40),
        }));
        const mismatch = spawnSync(process.execPath, [script, planPath, sourceDir], { encoding: 'utf8' });
        expect(mismatch.status).not.toBe(0);
        expect(mismatch.stderr).toContain('checkout identity mismatch');

        fs.writeFileSync(planPath, JSON.stringify({
            schema: 'betterdesk-real-client-plan/v1',
            sourceCommit: commit,
        }));
        fs.writeFileSync(path.join(sourceDir, 'tracked.txt'), 'changed\n');
        const dirty = spawnSync(process.execPath, [script, planPath, sourceDir], { encoding: 'utf8' });
        expect(dirty.status).not.toBe(0);
        expect(dirty.stderr).toContain('not clean');
    });

    test('workflow pins actions and selects source before applying the signed configuration', () => {
        const workflow = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/real-client-build.yml'), 'utf8');
        const adapter = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/build-real-client.mjs'), 'utf8');
        const readme = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/README.md'), 'utf8');
        const dependabot = fs.readFileSync(path.resolve(__dirname, '../../docs/real-client-build-repository/dependabot.yml'), 'utf8');
        expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d/);
        expect(workflow).not.toMatch(/allowCustom|ZIP_PASSWORD|save_custom_client|cleanzip/);
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('path: rustdesk-source');
        expect(workflow).toContain('ref: ${{ inputs.source_commit }}');
        expect(workflow).toContain('EXPECTED_WORKFLOW_COMMIT: ${{ inputs.workflow_commit }}');
        expect(workflow).toContain('verify-source-revision.mjs');
        expect(workflow).toContain('runs-on: ubuntu-22.04');
        expect(workflow).not.toContain('continue-on-error');
        expect(workflow.indexOf('Verify immutable central workflow revision'))
            .toBeLessThan(workflow.indexOf('Decrypt and validate BetterDesk payload'));
        expect(workflow.indexOf('Check out exact immutable RustDesk source'))
            .toBeLessThan(workflow.indexOf('Sign RustDesk custom configuration'));
        expect(workflow.indexOf('Verify clean source revision before transforms'))
            .toBeLessThan(workflow.indexOf('Apply revision-guarded common source patches'));
        expect(workflow.indexOf('Apply revision-guarded common source patches'))
            .toBeLessThan(workflow.indexOf('Sign RustDesk custom configuration'));
        expect(workflow.indexOf('Verify E2E-tested central build adapter is installed'))
            .toBeLessThan(workflow.indexOf('Decrypt and validate BetterDesk payload'));
        expect(workflow.indexOf('Verify complete central repository contract'))
            .toBeLessThan(workflow.indexOf('Decrypt and validate BetterDesk payload'));
        expect(workflow).toContain('node .betterdesk/verify-central-repository.mjs .');
        expect(workflow).toContain('needs: route');
        expect(workflow).toContain('runs-on: ${{ needs.route.outputs.runner }}');
        expect(workflow).toContain('environment: ${{ needs.route.outputs.environment }}');
        expect(workflow).toContain('REAL_CLIENT_RUNNER_WINDOWS_X64');
        expect(workflow).toContain('REAL_CLIENT_RUNNER_LINUX_ARM64');
        expect(workflow).toContain('REAL_CLIENT_RUNNER_MACOS_ARM64');
        expect(workflow).toContain('^betterdesk-[A-Za-z0-9][A-Za-z0-9._-]{0,116}$');
        expect(workflow).toContain('${LINUX_X64_RUNNER:-ubuntu-22.04}');
        expect(workflow).toContain('${ANDROID_X64_RUNNER:-ubuntu-22.04}');
        expect(workflow).toContain('linux-x64-*|android-*');
        expect(workflow).toContain('Reclaim and attest hosted Linux workspace');
        expect(workflow).toContain("needs.route.outputs.runner == 'ubuntu-22.04'");
        expect(workflow).toContain('docker system prune --all --force');
        expect(workflow).toContain('40 * 1024 * 1024 * 1024');
        expect(workflow).toContain('CARGO_EXPAND_VERSION: "1.0.95"');
        expect(workflow).toContain('FLUTTER_RUST_BRIDGE_VERSION: "1.80.1"');
        expect(workflow).toContain('Install pinned Flutter Rust bridge toolchain');
        expect(workflow).toContain('cargo install cargo-expand --version "$CARGO_EXPAND_VERSION" --locked');
        expect(workflow).toContain('cargo install flutter_rust_bridge_codegen --version "$FLUTTER_RUST_BRIDGE_VERSION" --features uuid --locked');
        expect(adapter).toContain("'src/bridge_generated.rs'");
        expect(adapter).toContain("'src/bridge_generated.io.rs'");
        expect(adapter).toContain("'flutter/lib/generated_bridge.freezed.dart'");
        expect(adapter.indexOf('await generateFlutterBridge(absoluteSource)'))
            .toBeLessThan(adapter.indexOf("if (profile.platform === 'windows') artifact"));
        expect(workflow).not.toMatch(/runs-on:\s*\$\{\{[^\n]*inputs\./);
        expect(workflow).not.toMatch(/environment:\s*\$\{\{[^\n]*inputs\./);
        for (const environment of [
            'betterdesk-real-client-windows',
            'betterdesk-real-client-linux',
            'betterdesk-real-client-flatpak',
            'betterdesk-real-client-android',
            'betterdesk-real-client-macos',
        ]) expect(workflow).toContain(environment);
        expect(workflow.indexOf('Verify adapter admission contract'))
            .toBeLessThan(workflow.indexOf('Check out exact immutable RustDesk source'));
        expect(workflow).toContain('test ! -L .betterdesk/build-real-client.mjs');
        expect(workflow).toContain('build-real-client.mjs .betterdesk-build/input .betterdesk-build/out rustdesk-source');
        expect(workflow).toContain('REAL_CLIENT_FLATPAK_GPG_PRIVATE_KEY_BASE64');
        expect(workflow).toContain('EXPECTED_FLATPAK_FINGERPRINT');
        expect(workflow).toContain('Remove imported Flatpak signing material');
        expect(workflow).toContain('Remove temporary Android signing material');
        expect(workflow).toContain('rm -f rustdesk-source/flutter/android/key.properties');
        expect(workflow).toContain('rm -rf .betterdesk-build/secrets');
        expect(workflow).toContain('Remove decrypted input and transformed source');
        expect(workflow).toContain('rm -rf .betterdesk-build rustdesk-source .betterdesk-toolchains');
        expect(workflow.lastIndexOf('Remove decrypted input and transformed source'))
            .toBeGreaterThan(workflow.indexOf('Publish one validated package'));
        expect(workflow).toContain('ARTIFACT_RETENTION_DAYS: ${{ inputs.artifact_retention_days }}');
        expect(workflow).toContain('Number(r)<1||Number(r)>365');
        expect(workflow).toMatch(/^\s+retention-days:\s+\$\{\{ inputs\.artifact_retention_days \}\}\s*$/m);
        const windowsBuildStep = workflow.match(/- name: Build, brand and sign exact Windows target[\s\S]*?(?=\n\s+- name:)/)[0];
        const androidBuildStep = workflow.match(/- name: Build, brand and sign exact Android target[\s\S]*?(?=\n\s+- name:)/)[0];
        const linuxBuildStep = workflow.match(/- name: Build and brand exact Linux package target[\s\S]*?(?=\n\s+- name:)/)[0];
        expect(androidBuildStep).toContain('REAL_CLIENT_ANDROID_KEYSTORE_BASE64');
        expect(androidBuildStep).toContain('REAL_CLIENT_ANDROID_CERT_SHA256');
        expect(windowsBuildStep).not.toContain('REAL_CLIENT_ANDROID_KEYSTORE_BASE64');
        expect(linuxBuildStep).not.toMatch(/secrets\.|REAL_CLIENT_(?:WINDOWS|ANDROID|MACOS|FLATPAK)/);
        expect(workflow).toContain('betterdesk-real-client-cert-thumbprints.txt');
        expect(workflow).toContain("$expected -notmatch '^[0-9A-F]{40}$'");
        expect(workflow).toContain('$imported | ForEach-Object { Remove-Item');
        expect(workflow).toContain('Windows signing certificate already exists on the runner');
        expect(workflow).toContain('Get-Content -LiteralPath $manifest | Where-Object');
        expect(workflow.indexOf('$expected | Set-Content -LiteralPath $manifest'))
            .toBeLessThan(workflow.indexOf('Import-PfxCertificate'));
        expect(workflow).toContain('Remove temporary macOS signing and notarization keychains');
        expect(workflow).toContain('REAL_CLIENT_MACOS_SIGN_KEYCHAIN');
        expect(workflow).toContain('security delete-keychain "$REAL_CLIENT_MACOS_SIGN_KEYCHAIN"');
        expect(workflow).toContain('cleanup_failed_import');
        expect(workflow).toContain('cleanup_failed_notary');
        expect(workflow).toContain('rm -f "$p12"');
        expect(workflow).not.toContain('apple-actions/import-codesign-certs');
        expect(workflow).toContain('security delete-keychain "$REAL_CLIENT_MACOS_NOTARY_KEYCHAIN"');
        expect(workflow.indexOf("printf 'REAL_CLIENT_MACOS_SIGN_DIR=%s\\n'"))
            .toBeLessThan(workflow.indexOf('security create-keychain -p "$keychain_password" "$signing_keychain"'));
        expect(workflow.indexOf("printf 'REAL_CLIENT_MACOS_NOTARY_DIR=%s\\n'"))
            .toBeLessThan(workflow.indexOf('security create-keychain -p "$keychain_password" "$keychain"'));
        expect(adapter).toContain("'--keychain', signingKeychain, '--sign'");
        expect(adapter).toContain("return { identity, signingKeychain }");
        expect(adapter).toContain("if (!path.isAbsolute(signingKeychain)");
        expect(adapter).toContain("'--keychain', notaryKeychain, '--wait'");
        expect(adapter).toContain('Flatpak builds require an approved GPG signing-key fingerprint');
        expect(readme).toContain('Never infer relay, WebSocket or API ports');
        expect(readme).toContain('customConfigVerification');
        expect(readme).toContain('codesign --verify --deep --strict');
        expect(dependabot).toContain('package-ecosystem: "github-actions"');
    });

    test('central adapter bootstrap installs one exact contract and check fails closed without pinned vendors', () => {
        const central = path.join(root, 'central-rustdesk');
        fs.mkdirSync(path.join(central, 'flutter'), { recursive: true });
        fs.writeFileSync(path.join(central, 'Cargo.toml'), '[package]\nname = "rustdesk"\n');
        fs.writeFileSync(path.join(central, 'build.py'), '# fixture\n');
        fs.writeFileSync(path.join(central, 'flutter/pubspec.yaml'), 'name: flutter_hbb\n');
        const git = (...args) => spawnSync('git', ['-C', central, ...args], { encoding: 'utf8' });
        expect(git('init').status).toBe(0);
        expect(git('config', 'user.name', 'BetterDesk Test').status).toBe(0);
        expect(git('config', 'user.email', 'test@example.invalid').status).toBe(0);
        expect(git('add', '.').status).toBe(0);
        expect(git('commit', '-m', 'fixture').status).toBe(0);

        const installer = path.resolve(__dirname, '../../docs/real-client-build-repository/install-central-adapter.mjs');
        const installed = spawnSync(process.execPath, [installer, central, '--install'], { encoding: 'utf8' });
        expect({ status: installed.status, stderr: installed.stderr }).toEqual({ status: 0, stderr: '' });
        for (const relative of [
            '.betterdesk/build-real-client.mjs',
            '.betterdesk/verify-central-repository.mjs',
            '.github/workflows/real-client-build.yml',
        ]) expect(fs.statSync(path.join(central, relative)).isFile()).toBe(true);

        expect(git('add', '.').status).toBe(0);
        expect(git('commit', '-m', 'adapter fixture').status).toBe(0);
        const checked = spawnSync(process.execPath, [installer, central, '--check'], { encoding: 'utf8' });
        expect(checked.status).not.toBe(0);
        expect(checked.stderr).toContain('RustDeskTempTopMostWindow checkout is missing');
    });
});
