import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_SOURCE_REVISIONS = Object.freeze({
    '1.4.9': '6c578292e8ebbbec708b76986ba8c4bc7c509747',
});
const ADAPTER_DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_REVISIONS = Object.freeze({
    privacyHelper: '53b548a5398624f7149a382000397993542ad796',
    flatpakSharedModules: '7b858d89ffe3bf9ce6e0390fe72691c9c5f322d3',
});
const TARGETS = Object.freeze({
    'windows-x64-exe': { host: 'win32', platform: 'windows', arch: 'x86_64', package: 'exe' },
    'windows-x64-msi': { host: 'win32', platform: 'windows', arch: 'x86_64', package: 'msi' },
    // RustDesk 1.4.9's maintained Flutter desktop path is x64. The legacy
    // Sciter x86 route is deliberately not advertised by this adapter.
    'windows-x86-exe': { unsupported: 'RustDesk 1.4.9 Windows x86 uses the legacy RDGen Sciter path and has no approved BetterDesk E2E profile' },
    'linux-x64-deb': { host: 'linux', platform: 'linux', arch: 'x86_64', package: 'deb' },
    'linux-x64-appimage': { host: 'linux', platform: 'linux', arch: 'x86_64', package: 'appimage' },
    'linux-x64-flatpak': { host: 'linux', platform: 'linux', arch: 'x86_64', package: 'flatpak' },
    'linux-arm64-deb': { host: 'linux', platform: 'linux', arch: 'aarch64', package: 'deb' },
    'linux-arm64-appimage': { host: 'linux', platform: 'linux', arch: 'aarch64', package: 'appimage' },
    'linux-arm64-flatpak': { host: 'linux', platform: 'linux', arch: 'aarch64', package: 'flatpak' },
    'android-arm64-apk': { host: 'linux', platform: 'android', arch: 'aarch64', package: 'apk', rustTarget: 'aarch64-linux-android', flutterTarget: 'android-arm64', abi: 'arm64-v8a' },
    'android-armv7-apk': { host: 'linux', platform: 'android', arch: 'armv7', package: 'apk', rustTarget: 'armv7-linux-androideabi', flutterTarget: 'android-arm', abi: 'armeabi-v7a' },
    'android-x64-apk': { host: 'linux', platform: 'android', arch: 'x86_64', package: 'apk', rustTarget: 'x86_64-linux-android', flutterTarget: 'android-x64', abi: 'x86_64' },
    'macos-x64-dmg': { host: 'darwin', platform: 'macos', arch: 'x86_64', package: 'dmg' },
    'macos-arm64-dmg': { host: 'darwin', platform: 'macos', arch: 'aarch64', package: 'dmg' },
});

const EXTENSIONS = Object.freeze({ exe: '.exe', msi: '.msi', deb: '.deb', appimage: '.appimage', flatpak: '.flatpak', apk: '.apk', dmg: '.dmg' });
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) {
    throw new Error(message);
}

async function readJson(file, name) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular file`);
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (_) {
        fail(`${name} is not valid JSON`);
    }
}

async function assertDirectory(directory, name) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name} must be a real directory`);
}

async function assertRegularFile(file, name) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular file`);
    return stat;
}

async function writePrivate(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
}

function countLiteral(value, needle) {
    if (!needle) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = value.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }
    return count;
}

async function replaceExact(root, relative, before, after, expected = 1) {
    const file = path.join(root, relative);
    await assertRegularFile(file, relative);
    const value = await fs.readFile(file, 'utf8');
    const actual = countLiteral(value, before);
    if (actual !== expected) fail(`${relative}: expected ${expected} exact source marker(s), found ${actual}`);
    await fs.writeFile(file, value.split(before).join(after), { encoding: 'utf8', mode: 0o600 });
}

async function replaceWhenConfigured(root, relative, before, after) {
    if (!after || before === after) return;
    await replaceExact(root, relative, before, after);
}

function tool(name) {
    const windows = process.platform === 'win32';
    const table = {
        python: windows ? 'python.exe' : 'python3',
        flutter: windows ? 'flutter.bat' : 'flutter',
        dart: windows ? 'dart.exe' : 'dart',
        cargo: windows ? 'cargo.exe' : 'cargo',
        msbuild: 'msbuild.exe',
        nuget: 'nuget.exe',
        magick: windows || process.platform === 'darwin' ? 'magick' : 'convert',
    };
    return table[name] || name;
}

function run(command, args, { cwd, env = {}, capture = false } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) fail('Build command arguments must be strings');
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            shell: false,
            windowsHide: true,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        let stdout = '';
        let stderr = '';
        if (capture) {
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
        }
        child.once('error', (error) => reject(new Error(`Required tool ${path.basename(command)} could not start: ${error.code || error.message}`)));
        child.once('close', (code, signal) => {
            if (code !== 0) return reject(new Error(`${path.basename(command)} failed (${signal || code})${capture && stderr ? `: ${stderr.slice(-2000)}` : ''}`));
            resolve({ stdout, stderr });
        });
    });
}

async function findExactlyOne(directory, predicate, description) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const matches = entries.filter((entry) => entry.isFile() && predicate(entry.name));
    if (matches.length !== 1) fail(`Expected exactly one ${description} in ${directory}, found ${matches.length}`);
    return path.join(directory, matches[0].name);
}

async function findExactlyOneDirectory(directory, predicate, description) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const matches = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && predicate(entry.name));
    if (matches.length !== 1) fail(`Expected exactly one ${description} in ${directory}, found ${matches.length}`);
    return path.join(directory, matches[0].name);
}

function safeArtifactBase(plan) {
    const version = plan.sourceRevision.replace(/[^A-Za-z0-9._-]/g, '-');
    // deriveConfigForBuild already gives QuickSupport its own immutable
    // executableName. Do not append the variant twice here.
    const base = `${plan.branding.executableName}-${version}-${plan.arch}`;
    if (!SAFE_FILENAME.test(base)) fail('Generated artifact base name is unsafe');
    return base;
}

async function copyOutput(source, outputDir, plan) {
    const extension = EXTENSIONS[plan.package];
    if (!extension) fail(`No output extension for ${plan.package}`);
    await assertRegularFile(source, 'built artifact');
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    const destination = path.join(outputDir, `${safeArtifactBase(plan)}${extension}`);
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    return destination;
}

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const handle = await fs.open(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        await handle.close();
    }
    return hash.digest('hex');
}

async function validatePng(file, label) {
    const stat = await assertRegularFile(file, label);
    if (stat.size < 24 || stat.size > 5 * 1024 * 1024) fail(`${label} has an invalid size`);
    const handle = await fs.open(file, 'r');
    try {
        const signature = Buffer.alloc(8);
        await handle.read(signature, 0, 8, 0);
        if (!signature.equals(PNG_SIGNATURE)) fail(`${label} is not PNG`);
    } finally {
        await handle.close();
    }
}

export async function applyBranding(plan, inputDir, sourceDir) {
    const { appName, companyName, executableName, customUrl, downloadUrl, androidAppId, macosBundleId } = plan.branding;
    const company = companyName || appName;
    const companySentence = /[.!?]$/.test(company) ? company : `${company}.`;
    const copyright = `Copyright © 2026 ${companySentence} All rights reserved.`;

    await replaceExact(sourceDir, 'Cargo.toml', 'description = "RustDesk Remote Desktop"', `description = ${JSON.stringify(`${appName} Remote Desktop`)}`, 1);
    await replaceExact(sourceDir, 'Cargo.toml', 'ProductName = "RustDesk"', `ProductName = ${JSON.stringify(appName)}`, 1);
    await replaceExact(sourceDir, 'Cargo.toml', 'FileDescription = "RustDesk Remote Desktop"', `FileDescription = ${JSON.stringify(`${appName} Remote Desktop`)}`, 1);
    await replaceExact(sourceDir, 'Cargo.toml', 'OriginalFilename = "rustdesk.exe"', `OriginalFilename = ${JSON.stringify(`${executableName}.exe`)}`, 1);
    await replaceExact(sourceDir, 'Cargo.toml', 'LegalCopyright = "Copyright © 2026 Purslane Tech Pte. Ltd. All rights reserved."', `LegalCopyright = ${JSON.stringify(copyright)}`, 1);

    await replaceExact(sourceDir, 'libs/portable/Cargo.toml', 'description = "RustDesk Remote Desktop"', `description = ${JSON.stringify(`${appName} Remote Desktop`)}`, 1);
    await replaceExact(sourceDir, 'libs/portable/Cargo.toml', 'ProductName = "RustDesk"', `ProductName = ${JSON.stringify(appName)}`, 1);
    await replaceExact(sourceDir, 'libs/portable/Cargo.toml', 'FileDescription = "RustDesk Remote Desktop"', `FileDescription = ${JSON.stringify(`${appName} Remote Desktop`)}`, 1);
    await replaceExact(sourceDir, 'libs/portable/Cargo.toml', 'OriginalFilename = "rustdesk.exe"', `OriginalFilename = ${JSON.stringify(`${executableName}.exe`)}`, 1);
    await replaceExact(sourceDir, 'libs/portable/Cargo.toml', 'LegalCopyright = "Copyright © 2026 Purslane Tech Pte. Ltd. All rights reserved."', `LegalCopyright = ${JSON.stringify(copyright)}`, 1);

    if (plan.platform === 'windows') {
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "CompanyName", "Purslane Tech Pte. Ltd."', `VALUE "CompanyName", ${JSON.stringify(company)}`, 1);
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "FileDescription", "RustDesk Remote Desktop"', `VALUE "FileDescription", ${JSON.stringify(`${appName} Remote Desktop`)}`, 1);
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "InternalName", "rustdesk"', `VALUE "InternalName", ${JSON.stringify(executableName)}`, 1);
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "LegalCopyright", "Copyright © 2026 Purslane Tech Pte. Ltd. All rights reserved."', `VALUE "LegalCopyright", ${JSON.stringify(copyright)}`, 1);
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "OriginalFilename", "rustdesk.exe"', `VALUE "OriginalFilename", ${JSON.stringify(`${executableName}.exe`)}`, 1);
        await replaceExact(sourceDir, 'flutter/windows/runner/Runner.rc', 'VALUE "ProductName", "RustDesk"', `VALUE "ProductName", ${JSON.stringify(appName)}`, 1);
    }

    if (plan.platform === 'macos') {
        await replaceExact(sourceDir, 'flutter/macos/Runner/Configs/AppInfo.xcconfig', 'PRODUCT_NAME = RustDesk', `PRODUCT_NAME = ${xcconfigValue(appName)}`, 1);
        await replaceExact(sourceDir, 'flutter/macos/Runner/Configs/AppInfo.xcconfig', 'PRODUCT_BUNDLE_IDENTIFIER = com.carriez.flutterHbb', `PRODUCT_BUNDLE_IDENTIFIER = ${macosBundleId}`, 1);
        await replaceExact(sourceDir, 'flutter/macos/Runner/Configs/AppInfo.xcconfig', 'PRODUCT_COPYRIGHT = Copyright © 2026 Purslane Tech Pte. Ltd. All rights reserved.', `PRODUCT_COPYRIGHT = ${xcconfigValue(copyright)}`, 1);
    }

    if (plan.platform === 'android') {
        await replaceExact(sourceDir, 'flutter/android/app/build.gradle', 'applicationId "com.carriez.flutter_hbb"', `applicationId ${JSON.stringify(androidAppId)}`, 1);
        await replaceExact(sourceDir, 'flutter/android/app/src/main/AndroidManifest.xml', 'android:label="RustDesk"', `android:label="${escapeXml(appName)}"`, 1);
        await replaceExact(sourceDir, 'flutter/android/app/src/main/res/values/strings.xml', '<string name="app_name">RustDesk</string>', `<string name="app_name">${escapeXml(appName)}</string>`, 1);
    }

    if (plan.platform === 'linux') {
        await replaceExact(sourceDir, 'res/rustdesk.desktop', 'Name=RustDesk', `Name=${desktopValue(appName)}`, 1);
        await replaceExact(sourceDir, 'res/rustdesk-link.desktop', 'Name=RustDesk', `Name=${desktopValue(appName)}`, 1);
    }

    await replaceExact(
        sourceDir,
        'flutter/lib/desktop/pages/desktop_setting_page.dart',
        'Purslane Tech Pte. Ltd.\\n$license',
        `${escapeDartSingle(company)}\\n$license`,
        1,
    );

    if (customUrl) {
        const site = customUrl.replace(/\/$/, '');
        const privacyUrl = appendUrlPath(site, 'privacy.html');
        await replaceWhenConfigured(sourceDir, 'build.py', 'Homepage: https://rustdesk.com', `Homepage: ${escapePythonTriple(site)}`);
        await replaceWhenConfigured(sourceDir, 'flutter/lib/common.dart', "launchUrl(Uri.parse('https://rustdesk.com'));", `launchUrl(Uri.parse('${escapeDartSingle(site)}'));`);
        await replaceWhenConfigured(sourceDir, 'flutter/lib/desktop/pages/desktop_setting_page.dart', "launchUrlString('https://rustdesk.com');", `launchUrlString('${escapeDartSingle(site)}');`);
        await replaceExact(sourceDir, 'flutter/lib/mobile/pages/settings_page.dart', "const url = 'https://rustdesk.com/';", `const url = '${escapeDartSingle(site)}';`, 2);
        await replaceWhenConfigured(sourceDir, 'flutter/lib/desktop/pages/desktop_setting_page.dart', "launchUrlString('https://rustdesk.com/privacy.html')", `launchUrlString('${escapeDartSingle(privacyUrl)}')`);
        await replaceExact(sourceDir, 'flutter/lib/mobile/pages/settings_page.dart', "launchUrlString('https://rustdesk.com/privacy.html')", `launchUrlString('${escapeDartSingle(privacyUrl)}')`, 1);
        await replaceExact(sourceDir, 'flutter/lib/desktop/pages/install_page.dart', "'https://rustdesk.com/privacy.html'", `'${escapeDartSingle(privacyUrl)}'`, 2);
    }
    if (downloadUrl) {
        await replaceWhenConfigured(sourceDir, 'flutter/lib/desktop/pages/desktop_home_page.dart', "Uri.parse('https://rustdesk.com/download')", `Uri.parse('${escapeDartSingle(downloadUrl)}')`);
        await replaceWhenConfigured(sourceDir, 'flutter/lib/mobile/pages/connection_page.dart', "final url = 'https://rustdesk.com/download';", `final url = '${escapeDartSingle(downloadUrl)}';`);
        await replaceWhenConfigured(sourceDir, 'src/ui/index.tis', 'handler.open_url("https://rustdesk.com/download");', `handler.open_url(${JSON.stringify(downloadUrl)});`);
    }

    const assetMappings = [
        ['logo', 'flutter/assets/logo.png'],
        ['icon', 'res/icon.png'],
        ['icon', 'res/mac-icon.png'],
        ['icon', 'flutter/assets/icon.png'],
    ];
    for (const [kind, destination] of assetMappings) {
        if (!plan.assets[kind]) continue;
        const source = path.join(inputDir, `${kind}.png`);
        await validatePng(source, `${kind} asset`);
        await fs.mkdir(path.dirname(path.join(sourceDir, destination)), { recursive: true });
        await fs.copyFile(source, path.join(sourceDir, destination));
    }

    if (plan.assets.icon) {
        const sizes = [['32x32.png', '32x32'], ['64x64.png', '64x64'], ['128x128.png', '128x128'], ['128x128@2x.png', '256x256']];
        for (const [name, size] of sizes) await run(tool('magick'), [path.join(sourceDir, 'res/icon.png'), '-resize', size, path.join(sourceDir, `res/${name}`)], { cwd: sourceDir });
        await run(tool('magick'), [path.join(sourceDir, 'res/icon.png'), '-define', 'icon:auto-resize=256,64,48,32,16', path.join(sourceDir, 'res/icon.ico')], { cwd: sourceDir });
        await fs.copyFile(path.join(sourceDir, 'res/icon.ico'), path.join(sourceDir, 'res/tray-icon.ico'));
        await run(tool('flutter'), ['pub', 'get'], { cwd: path.join(sourceDir, 'flutter') });
        await run(tool('flutter'), ['pub', 'run', 'flutter_launcher_icons'], { cwd: path.join(sourceDir, 'flutter') });
    }
}

function escapeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeDartSingle(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
}

function escapePythonTriple(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appendUrlPath(value, child) {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/${child}`;
    return parsed.toString();
}

function desktopValue(value) {
    if (/\r|\n/.test(value)) fail('Desktop application name contains a newline');
    return value.replace(/\\/g, '\\\\');
}

function xcconfigValue(value) {
    if (/[\\/$#;=]/.test(value)) fail('macOS application name contains an xcconfig metacharacter');
    return value;
}

async function stageCustomConfig(source, destination) {
    const stat = await assertRegularFile(source, 'signed custom configuration');
    if (stat.size < 64 || stat.size > 512 * 1024) fail('Signed custom configuration size is invalid');
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function generateFlutterBridge(sourceDir) {
    const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
    if (!path.isAbsolute(cargoHome)) fail('CARGO_HOME must be an absolute path');
    const executable = process.platform === 'win32'
        ? 'flutter_rust_bridge_codegen.exe'
        : 'flutter_rust_bridge_codegen';
    const codegen = path.join(cargoHome, 'bin', executable);
    await assertRegularFile(codegen, 'pinned flutter_rust_bridge_codegen executable');

    // RustDesk deliberately ignores generated FRB bindings. A clean checkout
    // therefore cannot compile the Flutter feature until the exact 1.4.9
    // bridge contract is regenerated. Keep this inside the executable adapter
    // so every supported platform gets the same fail-closed preparation.
    await run(tool('flutter'), ['pub', 'get'], { cwd: path.join(sourceDir, 'flutter') });
    await run(codegen, [
        '--rust-input', './src/flutter_ffi.rs',
        '--dart-output', './flutter/lib/generated_bridge.dart',
        '--c-output', './flutter/macos/Runner/bridge_generated.h',
    ], { cwd: sourceDir });
    await fs.copyFile(
        path.join(sourceDir, 'flutter/macos/Runner/bridge_generated.h'),
        path.join(sourceDir, 'flutter/ios/Runner/bridge_generated.h'),
    );
    for (const relative of [
        'src/bridge_generated.rs',
        'src/bridge_generated.io.rs',
        'flutter/lib/generated_bridge.dart',
        'flutter/lib/generated_bridge.freezed.dart',
        'flutter/macos/Runner/bridge_generated.h',
        'flutter/ios/Runner/bridge_generated.h',
    ]) {
        const stat = await assertRegularFile(path.join(sourceDir, relative), relative);
        if (stat.size === 0) fail(`${relative} generated an empty Flutter bridge file`);
    }
}

export async function embedSignedCustomConfig(sourceDir, signedConfig) {
    // Flutter desktop and Android initialize the Rust core through mainInit.
    // Passing the signed asset explicitly is deterministic on every platform;
    // relying only on current_exe()/custom.txt does not work inside an APK.
    const before = `      await _ffiBind.mainSetHomeDir(home: _homeDir);
      await _ffiBind.mainInit(
        appDir: _dir,
        customClientConfig: '',
      );`;
    const after = `      await _ffiBind.mainSetHomeDir(home: _homeDir);
      final customClientConfig =
          (await rootBundle.loadString('assets/custom.txt')).trim();
      await _ffiBind.mainInit(
        appDir: _dir,
        customClientConfig: customClientConfig,
      );`;
    await replaceExact(sourceDir, 'flutter/lib/models/native_model.dart', before, after, 1);
    await stageCustomConfig(signedConfig, path.join(sourceDir, 'flutter/assets/custom.txt'));
}

async function signWindows(file) {
    const identity = String(process.env.REAL_CLIENT_WINDOWS_SIGN_THUMBPRINT || '').trim();
    if (!/^[0-9A-F]{40}$/i.test(identity)) fail('Windows signing requires REAL_CLIENT_WINDOWS_SIGN_THUMBPRINT for an imported certificate');
    const timestamp = String(process.env.REAL_CLIENT_WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com').trim();
    await run('signtool.exe', ['sign', '/sha1', identity, '/fd', 'SHA256', '/tr', timestamp, '/td', 'SHA256', file], { cwd: path.dirname(file) });
    await run('signtool.exe', ['verify', '/pa', '/all', '/v', file], { cwd: path.dirname(file) });
}

async function signWindowsDirectory(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /\.(?:dll|exe)$/i.test(entry.name)).map((entry) => path.join(directory, entry.name)).sort();
    if (!files.length) fail('Windows build produced no signable binaries');
    for (const file of files) await signWindows(file);
}

async function buildWindows(plan, inputDir, outputDir, sourceDir) {
    await run(tool('python'), ['build.py', '--portable', '--hwcodec', '--flutter', '--vram', '--skip-portable-pack'], { cwd: sourceDir });
    const release = path.join(sourceDir, 'flutter/build/windows/x64/runner/Release');
    await assertDirectory(release, 'Windows release directory');
    await stageCustomConfig(path.join(inputDir, 'custom_.txt'), path.join(release, 'custom.txt'));
    if (plan.assets.logo) await fs.copyFile(path.join(inputDir, 'logo.png'), path.join(release, 'data/flutter_assets/assets/logo.png'));
    if (plan.assets.icon) await fs.copyFile(path.join(inputDir, 'icon.png'), path.join(release, 'data/flutter_assets/assets/icon.png'));

    await buildWindowsPrivacyComponent(inputDir, release, sourceDir, plan.assets.privacy);
    await signWindowsDirectory(release);

    const rustdeskExe = path.join(release, 'rustdesk.exe');
    await assertRegularFile(rustdeskExe, 'Windows RustDesk executable');
    const brandedExe = path.join(release, `${plan.branding.executableName}.exe`);
    await fs.rename(rustdeskExe, brandedExe);

    if (plan.package === 'exe') {
        await run(tool('python'), ['generate.py', '-f', release, '-o', '.', '-e', brandedExe], { cwd: path.join(sourceDir, 'libs/portable') });
        const packed = path.join(sourceDir, 'target/release/rustdesk-portable-packer.exe');
        await assertRegularFile(packed, 'Windows portable executable');
        await signWindows(packed);
        return copyOutput(packed, outputDir, plan);
    }

    if (plan.package === 'msi') {
        const msiDir = path.join(sourceDir, 'res/msi');
        await prepareWindowsMsiSources(plan, sourceDir);
        await run(tool('python'), [
            'preprocess.py',
            '--app-name', plan.branding.executableName,
            '--display-name', plan.branding.appName,
            '--manufacturer', plan.branding.companyName || plan.branding.appName,
            '--arp',
            '-d', release,
        ], { cwd: msiDir });
        await run(tool('nuget'), ['restore', 'msi.sln'], { cwd: msiDir });
        await run(tool('msbuild'), ['msi.sln', '-p:Configuration=Release', '-p:Platform=x64', '/p:TargetVersion=Windows10'], { cwd: msiDir });
        const msi = path.join(msiDir, 'Package/bin/x64/Release/en-us/Package.msi');
        await assertRegularFile(msi, 'Windows MSI');
        await signWindows(msi);
        return copyOutput(msi, outputDir, plan);
    }
    fail(`Unsupported Windows package ${plan.package}`);
}

export async function prepareWindowsMsiSources(plan, sourceDir) {
    if (plan.platform !== 'windows' || plan.package !== 'msi') return;
    // RustDesk 1.4.9's MSI preprocessor conflates its executable/service key
    // with the human-visible product name. Keep the safe executableName for
    // file/service/registry paths and introduce displayName only at UI fields.
    // Every marker is exact so an upstream MSI refactor fails before packaging.
    await replaceExact(
        sourceDir,
        'res/msi/preprocess.py',
        '    parser.add_argument(\n        "--app-name", type=str, default="RustDesk", help="The app name."\n    )',
        '    parser.add_argument(\n        "--app-name", type=str, default="RustDesk", help="The executable and service name."\n    )\n    parser.add_argument(\n        "--display-name", type=str, default="", help="The human-visible product name."\n    )',
        1,
    );
    await replaceExact(
        sourceDir,
        'res/msi/preprocess.py',
        '            f\'{indent}<?define Product="{args.app_name}" ?>\\n\',\n            f\'{indent}<?define Description="{args.app_name} Installer" ?>\\n\',',
        '            f\'{indent}<?define Product="{args.app_name}" ?>\\n\',\n            f\'{indent}<?define DisplayName="{args.display_name}" ?>\\n\',\n            f\'{indent}<?define Description="{args.display_name} Installer" ?>\\n\',',
        1,
    );
    await replaceExact(
        sourceDir,
        'res/msi/preprocess.py',
        'f\'{indent}<RegistryValue Type="string" Name="DisplayName" Value="{args.app_name}" />\\n\'',
        'f\'{indent}<RegistryValue Type="string" Name="DisplayName" Value="{args.display_name}" />\\n\'',
        1,
    );
    await replaceExact(
        sourceDir,
        'res/msi/preprocess.py',
        '    app_name = args.app_name\n    dist_dir = Path(sys.argv[0]).parent.joinpath(args.dist_dir).resolve()',
        '    app_name = args.app_name\n    args.display_name = args.display_name or args.app_name\n    dist_dir = Path(sys.argv[0]).parent.joinpath(args.dist_dir).resolve()',
        1,
    );
    await replaceExact(sourceDir, 'res/msi/preprocess.py', '    update_license_file(app_name)', '    update_license_file(args.display_name)', 1);
    await replaceExact(sourceDir, 'res/msi/preprocess.py', '    replace_app_name_in_langs(args.app_name)', '    replace_app_name_in_langs(args.display_name)', 1);
    await replaceExact(
        sourceDir,
        'res/msi/Package/Package.wxs',
        '<Package Name="$(var.Product)" Version="$(var.Version)"',
        '<Package Name="$(var.DisplayName)" Version="$(var.Version)"',
        1,
    );
}

async function buildWindowsPrivacyComponent(inputDir, releaseDir, sourceDir, customPrivacy) {
    const helper = path.join(ADAPTER_DIR, 'vendor/RustDeskTempTopMostWindow');
    await assertDirectory(helper, 'pinned RustDeskTempTopMostWindow source');
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: helper, capture: true });
    if (stdout.trim().toLowerCase() !== VENDOR_REVISIONS.privacyHelper) fail('RustDeskTempTopMostWindow source is not pinned to v0.3 commit');
    const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: helper, capture: true });
    if (status.stdout.trim()) fail('RustDeskTempTopMostWindow source must be clean before the privacy transform');
    if (customPrivacy) {
        await validatePng(path.join(inputDir, 'privacy.png'), 'privacy asset');
        const image = await fs.readFile(path.join(inputDir, 'privacy.png'));
        const rows = [];
        for (let offset = 0; offset < image.length; offset += 20) {
            rows.push([...image.subarray(offset, offset + 20)].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(', '));
        }
        const generated = `#include "pch.h"\n#include "./img.h"\n\nconst unsigned char g_img[] = {\n${rows.join(',\n')}\n};\n\nconst long long g_imgLen = sizeof(g_img);\n`;
        await fs.writeFile(path.join(helper, 'WindowInjection/img.cpp'), generated, { encoding: 'utf8', mode: 0o600 });
    }
    await run(tool('msbuild'), ['WindowInjection/WindowInjection.vcxproj', '-p:Configuration=Release', '-p:Platform=x64', '/p:TargetVersion=Windows10'], { cwd: helper });
    const dll = path.join(helper, 'WindowInjection/x64/Release/WindowInjection.dll');
    await assertRegularFile(dll, 'privacy WindowInjection.dll');
    await fs.copyFile(dll, path.join(releaseDir, 'WindowInjection.dll'));
}

async function buildLinux(plan, inputDir, outputDir, sourceDir) {
    const machine = os.arch();
    const expectedMachine = plan.arch === 'aarch64' ? 'arm64' : 'x64';
    if (machine !== expectedMachine) fail(`Target ${plan.target} requires a native ${expectedMachine} Linux runner, got ${machine}`);
    await stageCustomConfig(path.join(inputDir, 'custom_.txt'), path.join(sourceDir, 'flutter/tmpdeb/usr/share/rustdesk/custom.txt'));
    await run(tool('python'), ['build.py', '--flutter', '--hwcodec', '--unix-file-copy-paste'], {
        cwd: sourceDir,
        env: { CARGO_INCREMENTAL: '0', DEB_ARCH: plan.arch === 'aarch64' ? 'arm64' : 'amd64' },
    });
    const deb = await findExactlyOne(sourceDir, (name) => /^rustdesk-.*\.deb$/i.test(name), 'RustDesk DEB');
    if (plan.package === 'deb') return copyOutput(deb, outputDir, plan);

    if (plan.package === 'appimage') {
        const appimageDir = path.join(sourceDir, 'appimage');
        await fs.copyFile(deb, path.join(appimageDir, 'rustdesk.deb'));
        const recipe = path.join(appimageDir, `AppImageBuilder-${plan.arch}.yml`);
        await assertRegularFile(recipe, 'AppImage recipe');
        await run('appimage-builder', ['--skip-tests', '--recipe', recipe], { cwd: appimageDir });
        const appimage = await findExactlyOne(appimageDir, (name) => name.toLowerCase().endsWith('.appimage'), 'AppImage');
        return copyOutput(appimage, outputDir, plan);
    }

    if (plan.package === 'flatpak') {
        const flatpakDir = path.join(sourceDir, 'flatpak');
        const sharedModules = path.join(ADAPTER_DIR, 'vendor/flatpak-shared-modules');
        await assertDirectory(sharedModules, 'pinned Flatpak shared-modules checkout');
        const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: sharedModules, capture: true });
        if (stdout.trim().toLowerCase() !== VENDOR_REVISIONS.flatpakSharedModules) fail('Flatpak shared-modules source revision is not approved');
        const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: sharedModules, capture: true });
        if (status.stdout.trim()) fail('Flatpak shared-modules checkout must be clean');
        await fs.cp(sharedModules, path.join(flatpakDir, 'shared-modules'), { recursive: true, errorOnExist: true, force: false });
        await fs.copyFile(deb, path.join(flatpakDir, 'rustdesk.deb'));
        await run('flatpak-builder', ['--user', '--install-deps-from=flathub', '-y', '--force-clean', '--repo=repo', 'build', 'rustdesk.json'], { cwd: flatpakDir });
        const destination = path.join(flatpakDir, 'betterdesk.flatpak');
        const gpg = String(process.env.REAL_CLIENT_FLATPAK_GPG_KEY || '').trim();
        if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/i.test(gpg)) fail('Flatpak builds require an approved GPG signing-key fingerprint');
        const args = ['build-bundle', `--gpg-sign=${gpg}`, 'repo', destination, 'com.rustdesk.RustDesk'];
        await run('flatpak', args, { cwd: flatpakDir });
        return copyOutput(destination, outputDir, plan);
    }
    fail(`Unsupported Linux package ${plan.package}`);
}

function escapeJavaProperty(value) {
    let output = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const char = value[index];
        if (char === '\\') output += '\\\\';
        else if (char === '\t') output += '\\t';
        else if (char === '\n') output += '\\n';
        else if (char === '\r') output += '\\r';
        else if (char === '\f') output += '\\f';
        else if (char === ' ' && index === 0) output += '\\ ';
        else if (':=#!'.includes(char)) output += `\\${char}`;
        else if (code < 0x20 || code > 0x7e) output += `\\u${code.toString(16).padStart(4, '0')}`;
        else output += char;
    }
    return output;
}

export async function prepareAndroidSigning(sourceDir, secretRoot = os.tmpdir()) {
    const encoded = String(process.env.REAL_CLIENT_ANDROID_KEYSTORE_BASE64 || '');
    const storePassword = String(process.env.REAL_CLIENT_ANDROID_STORE_PASSWORD || '');
    const keyAlias = String(process.env.REAL_CLIENT_ANDROID_KEY_ALIAS || '');
    const keyPassword = String(process.env.REAL_CLIENT_ANDROID_KEY_PASSWORD || '');
    if (!encoded || !storePassword || !keyAlias || !keyPassword) fail('Android release signing secrets are not fully configured');
    const decoded = Buffer.from(encoded, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/\s+/g, '').replace(/=+$/, '')) fail('Android keystore is not canonical Base64');
    const absoluteSecretRoot = path.resolve(secretRoot);
    await fs.mkdir(absoluteSecretRoot, { recursive: true, mode: 0o700 });
    const secretDir = await fs.mkdtemp(path.join(absoluteSecretRoot, 'betterdesk-android-sign-'));
    const keyStore = path.join(secretDir, 'release.jks');
    const propertiesPath = path.join(sourceDir, 'flutter/android/key.properties');
    let propertiesCreated = false;
    try {
        await writePrivate(keyStore, decoded);
        const properties = `storePassword=${escapeJavaProperty(storePassword)}\nkeyPassword=${escapeJavaProperty(keyPassword)}\nkeyAlias=${escapeJavaProperty(keyAlias)}\nstoreFile=${escapeJavaProperty(keyStore)}\n`;
        const propertiesHandle = await fs.open(propertiesPath, 'wx', 0o600);
        propertiesCreated = true;
        try {
            await propertiesHandle.writeFile(properties, { encoding: 'ascii' });
        } finally {
            await propertiesHandle.close();
        }
        return secretDir;
    } catch (error) {
        if (propertiesCreated) await fs.rm(propertiesPath, { force: true }).catch(() => {});
        await fs.rm(secretDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

export function verifyAndroidSignerOutput(output, expectedFingerprint) {
    const expected = String(expectedFingerprint || '').replace(/[:\s]/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(expected)) fail('Android signing certificate SHA-256 fingerprint is invalid');
    const found = [...String(output || '').matchAll(/certificate SHA-256 digest:\s*([0-9A-F:]{64,95})/gi)]
        .map((match) => match[1].replace(/[:\s]/g, '').toUpperCase())
        .filter((value) => /^[0-9A-F]{64}$/.test(value));
    if (!found.includes(expected)) fail('Android APK signer does not match the configured certificate fingerprint');
    return expected;
}

async function buildAndroid(plan, inputDir, outputDir, sourceDir, profile) {
    if (os.arch() !== 'x64') fail('Android builds require the approved x64 Linux runner');
    const ndk = String(process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT || '').trim();
    if (!path.isAbsolute(ndk)) fail('ANDROID_NDK_HOME must be an absolute path');
    const secretDir = await prepareAndroidSigning(sourceDir, path.join(path.dirname(inputDir), 'secrets'));
    try {
        await run(tool('cargo'), ['ndk', '--version'], { cwd: sourceDir });
        const ndkScript = { aarch64: 'ndk_arm64.sh', armv7: 'ndk_arm.sh', x86_64: 'ndk_x64.sh' }[plan.arch];
        await run('bash', [path.join(sourceDir, `flutter/${ndkScript}`)], { cwd: sourceDir, env: { ANDROID_NDK_HOME: ndk, ANDROID_NDK_ROOT: ndk } });
        const nativeDir = path.join(sourceDir, `flutter/android/app/src/main/jniLibs/${profile.abi}`);
        await fs.mkdir(nativeDir, { recursive: true });
        await fs.copyFile(path.join(sourceDir, `target/${profile.rustTarget}/release/liblibrustdesk.so`), path.join(nativeDir, 'librustdesk.so'));
        const ndkTriple = plan.arch === 'aarch64' ? 'aarch64-linux-android' : plan.arch === 'armv7' ? 'arm-linux-androideabi' : 'x86_64-linux-android';
        const prebuiltRoot = path.join(ndk, 'toolchains/llvm/prebuilt');
        const prebuilt = await findExactlyOneDirectory(prebuiltRoot, () => true, 'Android NDK host prebuilt directory');
        const cxx = path.join(prebuilt, `sysroot/usr/lib/${ndkTriple}/libc++_shared.so`);
        await fs.copyFile(cxx, path.join(nativeDir, 'libc++_shared.so'));
        await run(tool('flutter'), ['build', 'apk', '--release', '--target-platform', profile.flutterTarget, '--split-per-abi'], { cwd: path.join(sourceDir, 'flutter') });
        const apk = path.join(sourceDir, `flutter/build/app/outputs/flutter-apk/app-${profile.abi}-release.apk`);
        await assertRegularFile(apk, 'Android APK');
        const apksigner = String(process.env.APKSIGNER || 'apksigner');
        const verification = await run(apksigner, ['verify', '--verbose', '--print-certs', apk], { cwd: sourceDir, capture: true });
        const signer = verifyAndroidSignerOutput(
            `${verification.stdout}\n${verification.stderr}`,
            process.env.REAL_CLIENT_ANDROID_CERT_SHA256,
        );
        process.stdout.write(`Android APK signature verified (${signer}).\n`);
        return copyOutput(apk, outputDir, plan);
    } finally {
        await fs.rm(path.join(sourceDir, 'flutter/android/key.properties'), { force: true });
        await fs.rm(secretDir, { recursive: true, force: true });
    }
}

async function signMacBundle(app, sourceDir) {
    const identity = String(process.env.REAL_CLIENT_MACOS_SIGN_IDENTITY || '').trim();
    if (!identity || /[\r\n\0]/.test(identity)) fail('macOS signing requires REAL_CLIENT_MACOS_SIGN_IDENTITY');
    const signingKeychain = String(process.env.REAL_CLIENT_MACOS_SIGN_KEYCHAIN || '').trim();
    if (!path.isAbsolute(signingKeychain) || /[\r\n\0]/.test(signingKeychain)) {
        fail('macOS signing requires an absolute temporary keychain path');
    }
    await assertRegularFile(signingKeychain, 'macOS signing keychain');
    const entitlements = path.join(sourceDir, 'flutter/macos/Runner/Release.entitlements');
    await assertRegularFile(entitlements, 'macOS release entitlements');
    const roots = [path.join(app, 'Contents/Frameworks'), path.join(app, 'Contents/PlugIns'), path.join(app, 'Contents/MacOS')];
    const signables = [];
    for (const root of roots) {
        try {
            const walk = async (directory) => {
                for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                    const item = path.join(directory, entry.name);
                    if (entry.isDirectory()) {
                        await walk(item);
                        if (/\.(?:framework|app|xpc|bundle)$/i.test(entry.name)) signables.push(item);
                    } else if (entry.isFile()) {
                        const stat = await fs.stat(item);
                        if (/\.(?:dylib|so)$/i.test(entry.name) || (stat.mode & 0o111) !== 0) signables.push(item);
                    }
                }
            };
            await walk(root);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    signables.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
    for (const item of signables) await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--keychain', signingKeychain, '--sign', identity, item], { cwd: sourceDir });
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, '--keychain', signingKeychain, '--sign', identity, app], { cwd: sourceDir });
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { cwd: sourceDir });
    return { identity, signingKeychain };
}

async function buildMac(plan, inputDir, outputDir, sourceDir) {
    const expectedMachine = plan.arch === 'aarch64' ? 'arm64' : 'x64';
    if (os.arch() !== expectedMachine) fail(`Target ${plan.target} requires a native ${expectedMachine} macOS runner`);
    await run(tool('python'), ['build.py', '--flutter', '--hwcodec', '--unix-file-copy-paste'], { cwd: sourceDir });
    const release = path.join(sourceDir, 'flutter/build/macos/Build/Products/Release');
    const appEntries = (await fs.readdir(release, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (appEntries.length !== 1) fail(`Expected exactly one macOS app bundle, found ${appEntries.length}`);
    const app = path.join(release, appEntries[0].name);
    await stageCustomConfig(path.join(inputDir, 'custom_.txt'), path.join(app, 'Contents/Resources/custom.txt'));
    if (plan.assets.logo) await fs.copyFile(path.join(inputDir, 'logo.png'), path.join(app, 'Contents/Frameworks/App.framework/Versions/Current/Resources/flutter_assets/assets/logo.png'));
    if (plan.assets.icon) await fs.copyFile(path.join(inputDir, 'icon.png'), path.join(app, 'Contents/Frameworks/App.framework/Versions/Current/Resources/flutter_assets/assets/icon.png'));
    const { identity, signingKeychain } = await signMacBundle(app, sourceDir);
    const dmg = path.join(sourceDir, `${safeArtifactBase(plan)}.dmg`);
    await run('create-dmg', ['--volname', plan.branding.appName, '--icon', path.basename(app), '200', '190', '--hide-extension', path.basename(app), '--window-size', '800', '400', '--app-drop-link', '600', '185', dmg, app], { cwd: release });
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--keychain', signingKeychain, '--sign', identity, dmg], { cwd: sourceDir });
    await run('codesign', ['--verify', '--strict', '--verbose=2', dmg], { cwd: sourceDir });
    const notaryProfile = String(process.env.REAL_CLIENT_MACOS_NOTARY_PROFILE || '').trim();
    const notaryKeychain = String(process.env.REAL_CLIENT_MACOS_NOTARY_KEYCHAIN || '').trim();
    if (String(process.env.REAL_CLIENT_REQUIRE_NOTARIZATION || 'true').toLowerCase() !== 'false') {
        if (!notaryProfile || /[\r\n\0]/.test(notaryProfile)) fail('macOS notarization requires REAL_CLIENT_MACOS_NOTARY_PROFILE');
        if (!path.isAbsolute(notaryKeychain) || /[\r\n\0]/.test(notaryKeychain)) fail('macOS notarization requires an absolute temporary keychain path');
        await assertRegularFile(notaryKeychain, 'macOS notarization keychain');
        await run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', notaryProfile, '--keychain', notaryKeychain, '--wait'], { cwd: sourceDir });
        await run('xcrun', ['stapler', 'staple', dmg], { cwd: sourceDir });
        await run('xcrun', ['stapler', 'validate', dmg], { cwd: sourceDir });
    }
    return copyOutput(dmg, outputDir, plan);
}

function validatePlan(plan, profile) {
    if (!plan || plan.schema !== 'betterdesk-real-client-plan/v1') fail('Unsupported build plan');
    if (!profile) fail(`Target is not allow-listed: ${plan?.target}`);
    if (profile.unsupported) fail(profile.unsupported);
    const expectedSourceCommit = SUPPORTED_SOURCE_REVISIONS[plan.sourceRevision];
    if (!expectedSourceCommit) fail(`No revision-guarded build adapter for RustDesk ${plan.sourceRevision}`);
    if (plan.platform !== profile.platform || plan.arch !== profile.arch || plan.package !== profile.package) fail('Build plan target metadata is inconsistent');
    if (process.platform !== profile.host) fail(`Target ${plan.target} requires ${profile.host}, got ${process.platform}`);
    if (!/^[0-9a-f]{40}$/.test(plan.sourceCommit || '')) fail('Build plan source commit is not immutable');
    if (plan.sourceCommit !== expectedSourceCommit) fail(`RustDesk ${plan.sourceRevision} source commit is not the approved adapter revision`);
    if (!['client', 'quicksupport'].includes(plan.clientVariant)) fail('Build plan client variant is invalid');
    if (plan.sourcePatches?.customConfigVerification !== 'ed25519-required') fail('Signed custom configuration verification is mandatory');
    if (!SAFE_FILENAME.test(plan.branding?.executableName || '')) fail('Executable name is invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(plan.branding?.macosBundleId || '')) {
        fail('macOS bundle identifier is invalid');
    }
}

export async function applyPlatformBuildCompatibility(plan, sourceDir) {
    if (plan.platform !== 'linux' || plan.arch !== 'aarch64') return;
    // RustDesk 1.4.9 hard-codes Flutter's x64 output path. Its ARM64 route in
    // RDGen uses Sony's Flutter-elinux wrapper; keep both source changes exact
    // and revision-guarded instead of selecting a mutable helper at runtime.
    await replaceExact(
        sourceDir,
        'build.py',
        "flutter_build_dir = 'build/linux/x64/release/bundle/'",
        "flutter_build_dir = 'build/linux/arm64/release/bundle/'",
        1,
    );
    await replaceExact(
        sourceDir,
        'build.py',
        "    os.chdir('flutter')\n    system2('flutter build linux --release')\n    system2('mkdir -p tmpdeb/usr/bin/')",
        "    os.chdir('flutter')\n    system2('flutter-elinux build linux --verbose')\n    system2('mkdir -p tmpdeb/usr/bin/')",
        1,
    );
}

export function describeBuildAdapter() {
    return {
        schema: 'betterdesk-real-client-adapter/v1',
        sourceRevisions: { ...SUPPORTED_SOURCE_REVISIONS },
        targets: Object.entries(TARGETS).map(([id, profile]) => ({
            id,
            implementedByAdapter: !profile.unsupported,
            reason: profile.unsupported || null,
            platform: profile.platform || null,
            arch: profile.arch || null,
            package: profile.package || null,
        })),
        vendorRevisions: { ...VENDOR_REVISIONS },
    };
}

export async function prepareSourceForBuild(plan, inputDir, sourceDir) {
    const profile = TARGETS[plan?.target];
    validatePlan(plan, profile);
    await applyBranding(plan, path.resolve(inputDir), path.resolve(sourceDir));
    await applyPlatformBuildCompatibility(plan, path.resolve(sourceDir));
    return profile;
}

export async function buildRealClient(inputDir, outputDir, sourceDir) {
    const absoluteInput = path.resolve(inputDir);
    const absoluteOutput = path.resolve(outputDir);
    const absoluteSource = path.resolve(sourceDir);
    await assertDirectory(absoluteInput, 'build input directory');
    await assertDirectory(absoluteSource, 'RustDesk source directory');
    const plan = await readJson(path.join(absoluteInput, 'build-plan.json'), 'build plan');
    const profile = TARGETS[plan.target];
    const signedConfig = path.join(absoluteInput, 'custom_.txt');
    await assertRegularFile(signedConfig, 'signed custom configuration');
    await prepareSourceForBuild(plan, absoluteInput, absoluteSource);
    await embedSignedCustomConfig(absoluteSource, signedConfig);
    await generateFlutterBridge(absoluteSource);

    let artifact;
    if (profile.platform === 'windows') artifact = await buildWindows(plan, absoluteInput, absoluteOutput, absoluteSource);
    else if (profile.platform === 'linux') artifact = await buildLinux(plan, absoluteInput, absoluteOutput, absoluteSource);
    else if (profile.platform === 'android') artifact = await buildAndroid(plan, absoluteInput, absoluteOutput, absoluteSource, profile);
    else if (profile.platform === 'macos') artifact = await buildMac(plan, absoluteInput, absoluteOutput, absoluteSource);
    else fail(`No build adapter for ${profile.platform}`);

    const stat = await assertRegularFile(artifact, 'final build artifact');
    if (stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) fail('Final build artifact size is invalid');
    const digest = await sha256File(artifact);
    process.stdout.write(`Built one validated ${plan.target} artifact (sha256 ${digest}).\n`);
    return artifact;
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
    if (process.argv[2] === '--describe') {
        process.stdout.write(`${JSON.stringify(describeBuildAdapter(), null, 2)}\n`);
    } else {
        const [inputDir = '.betterdesk-build/input', outputDir = '.betterdesk-build/out', sourceDir = 'rustdesk-source'] = process.argv.slice(2);
        await buildRealClient(inputDir, outputDir, sourceDir);
    }
}
