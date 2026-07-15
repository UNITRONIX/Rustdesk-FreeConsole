import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_ADAPTER_FILES = Object.freeze([
    'decrypt-payload.mjs',
    'extract-build-input.mjs',
    'verify-source-revision.mjs',
    'apply-source-patches.mjs',
    'sign-custom-config.mjs',
    'build-real-client.mjs',
    'validate-output.mjs',
    'verify-central-repository.mjs',
]);

const REQUIRED_WORKFLOW_INPUTS = Object.freeze([
    'build_id',
    'payload_url',
    'target',
    'rustdesk_version',
    'source_commit',
    'workflow_commit',
    'artifact_retention_days',
]);

const VENDORS = Object.freeze([
    {
        name: 'RustDeskTempTopMostWindow',
        path: '.betterdesk/vendor/RustDeskTempTopMostWindow',
        contractKey: 'privacyHelper',
    },
    {
        name: 'flatpak shared modules',
        path: '.betterdesk/vendor/flatpak-shared-modules',
        contractKey: 'flatpakSharedModules',
    },
]);

const PLATFORM_ENVIRONMENTS = Object.freeze([
    'betterdesk-real-client-windows',
    'betterdesk-real-client-linux',
    'betterdesk-real-client-flatpak',
    'betterdesk-real-client-android',
    'betterdesk-real-client-macos',
]);

function fail(message) {
    throw new Error(message);
}

function git(root, args) {
    const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        fail(`git ${args[0]} failed: ${String(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
}

async function regularFile(file, label) {
    let stat;
    try {
        stat = await fs.lstat(file);
    } catch (error) {
        if (error.code === 'ENOENT') fail(`${label} is missing`);
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
    return stat;
}

async function sha256(file) {
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function validateWorkflow(workflow) {
    if (!workflow.includes('run-name: Real Client ${{ inputs.build_id }}')) {
        fail('workflow run-name must include the exact BetterDesk build ID');
    }
    for (const input of REQUIRED_WORKFLOW_INPUTS) {
        if (!new RegExp(`^      ${input}:\\s*$`, 'm').test(workflow)) {
            fail(`workflow_dispatch input ${input} is missing`);
        }
    }
    for (const script of REQUIRED_ADAPTER_FILES) {
        if (script === 'verify-central-repository.mjs') continue;
        if (!workflow.includes(`.betterdesk/${script}`)) {
            fail(`workflow does not invoke the installed ${script}`);
        }
    }
    if (!workflow.includes('node .betterdesk/verify-central-repository.mjs .')) {
        fail('workflow does not invoke the complete central repository verifier');
    }
    const runnerVariables = [
        'REAL_CLIENT_RUNNER_WINDOWS_X64',
        'REAL_CLIENT_RUNNER_LINUX_X64',
        'REAL_CLIENT_RUNNER_LINUX_ARM64',
        'REAL_CLIENT_RUNNER_ANDROID_X64',
        'REAL_CLIENT_RUNNER_MACOS_X64',
        'REAL_CLIENT_RUNNER_MACOS_ARM64',
    ];
    if (!/^  route:\s*$/m.test(workflow)
        || !/^    needs: route\s*$/m.test(workflow)
        || !/^    runs-on: \$\{\{ needs\.route\.outputs\.runner \}\}\s*$/m.test(workflow)
        || !/^    environment: \$\{\{ needs\.route\.outputs\.environment \}\}\s*$/m.test(workflow)
        || !/^      environment: \$\{\{ steps\.runner\.outputs\.environment \}\}\s*$/m.test(workflow)
        || !workflow.includes("printf 'environment=%s\\n' \"$environment\" >> \"$GITHUB_OUTPUT\"")) {
        fail('workflow must resolve every signing job through the protected runner-routing job');
    }
    for (const variable of runnerVariables) {
        if (!workflow.includes(`vars.${variable}`)) {
            fail(`workflow protected runner variable ${variable} is missing`);
        }
    }
    if (!workflow.includes('^betterdesk-[A-Za-z0-9][A-Za-z0-9._-]{0,116}$')) {
        fail('workflow must require a dedicated betterdesk-* signing-runner label');
    }
    if (!workflow.includes('${LINUX_X64_RUNNER:-ubuntu-22.04}')
        || !workflow.includes('${ANDROID_X64_RUNNER:-ubuntu-22.04}')
        || !workflow.includes('linux-x64-*|android-*')
        || !workflow.includes('The fixed GitHub-hosted runner is allowed only for Linux x64 and Android')) {
        fail('fixed GitHub-hosted routing must be limited to Linux x64 and Android');
    }
    const hostedWorkspaceStep = workflow.match(/- name: Reclaim and attest hosted Linux workspace[\s\S]*?(?=\n\s+- name:)/)?.[0] || '';
    if (!hostedWorkspaceStep.includes("needs.route.outputs.runner == 'ubuntu-22.04'")
        || !hostedWorkspaceStep.includes('/usr/share/swift')
        || !hostedWorkspaceStep.includes('/usr/local/lib/android/sdk/ndk')
        || !hostedWorkspaceStep.includes('command -v node')
        || !hostedWorkspaceStep.includes('docker system prune --all --force')
        || !hostedWorkspaceStep.includes('40 * 1024 * 1024 * 1024')
        || !hostedWorkspaceStep.includes('Hosted Linux workspace has less than the required 40 GiB free')) {
        fail('GitHub-hosted Linux builds must reclaim and attest at least 40 GiB before checkout');
    }
    const linuxDependenciesStep = workflow.match(/- name: Install Linux system and vcpkg dependencies[\s\S]*?(?=\n\s+- name:)/)?.[0] || '';
    if (!linuxDependenciesStep.includes('apt-get remove -y libunwind-14-dev')
        || !linuxDependenciesStep.includes('libunwind-dev libva-dev')
        || !linuxDependenciesStep.includes('libgstreamer1.0-dev')) {
        fail('Ubuntu 22.04 Linux dependencies must resolve the versioned libunwind/GStreamer conflict');
    }
    const flutterBridgeStep = workflow.match(/- name: Install pinned Flutter Rust bridge toolchain[\s\S]*?(?=\n\s+- name:)/)?.[0] || '';
    if (!workflow.includes('CARGO_EXPAND_VERSION: "1.0.95"')
        || !workflow.includes('FLUTTER_RUST_BRIDGE_VERSION: "1.80.1"')
        || !flutterBridgeStep.includes('cargo install cargo-expand --version "$CARGO_EXPAND_VERSION" --locked')
        || !flutterBridgeStep.includes('cargo install flutter_rust_bridge_codegen --version "$FLUTTER_RUST_BRIDGE_VERSION" --features uuid --locked')
        || !flutterBridgeStep.includes('flutter_rust_bridge_codegen --version')) {
        fail('RustDesk 1.4.9 builds must install and attest the pinned Flutter Rust bridge generator');
    }
    if (/runs-on:\s*\$\{\{[^\n]*inputs\./.test(workflow)) {
        fail('workflow_dispatch inputs must never select a signing runner');
    }
    for (const environment of PLATFORM_ENVIRONMENTS) {
        if (!workflow.includes(`environment="${environment}"`)) {
            fail(`workflow protected platform environment ${environment} is missing`);
        }
    }
    if (/environment:\s*\$\{\{[^\n]*inputs\./.test(workflow)) {
        fail('workflow_dispatch inputs must never select a signing environment');
    }
    const androidBuildStep = workflow.match(/- name: Build, brand and sign exact Android target[\s\S]*?(?=\n\s+- name:)/)?.[0] || '';
    const windowsBuildStep = workflow.match(/- name: Build, brand and sign exact Windows target[\s\S]*?(?=\n\s+- name:)/)?.[0] || '';
    if (!androidBuildStep.includes('REAL_CLIENT_ANDROID_KEYSTORE_BASE64')
        || !androidBuildStep.includes('REAL_CLIENT_ANDROID_CERT_SHA256')
        || windowsBuildStep.includes('REAL_CLIENT_ANDROID_KEYSTORE_BASE64')) {
        fail('platform signing credentials must be scoped only to their matching build step');
    }
    if (!workflow.includes('Remove temporary macOS signing and notarization keychains')
        || !workflow.includes('REAL_CLIENT_MACOS_SIGN_KEYCHAIN')
        || !workflow.includes('REAL_CLIENT_MACOS_NOTARY_KEYCHAIN')
        || !workflow.includes('security delete-keychain "$REAL_CLIENT_MACOS_SIGN_KEYCHAIN"')
        || !workflow.includes('rm -f "$p12"')
        || !workflow.includes('cleanup_failed_import')
        || !workflow.includes('cleanup_failed_notary')
        || workflow.includes('apple-actions/import-codesign-certs')) {
        fail('macOS signing and notarization credentials must use explicit temporary keychains with unconditional cleanup');
    }
    if (!workflow.includes('$imported | ForEach-Object { Remove-Item "Cert:\\CurrentUser\\My\\$($_.Thumbprint)"')) {
        fail('Windows signing certificate import must clean up immediately when validation fails');
    }
    if (!workflow.includes('Windows signing certificate already exists on the runner')
        || !workflow.includes('$expected | Set-Content -LiteralPath $manifest')
        || !workflow.includes('Get-Content -LiteralPath $manifest | Where-Object')
        || workflow.indexOf('$expected | Set-Content -LiteralPath $manifest') > workflow.indexOf('Import-PfxCertificate')) {
        fail('Windows signing certificate cleanup manifest must be armed before certificate import');
    }
    if (!workflow.includes('Remove temporary Android signing material')
        || !workflow.includes('rm -f rustdesk-source/flutter/android/key.properties')
        || !workflow.includes('rm -rf .betterdesk-build/secrets')) {
        fail('Android signing material must have unconditional workflow cleanup');
    }
    if (!workflow.includes('Remove decrypted input and transformed source')
        || !workflow.includes('if: always()')
        || !workflow.includes('rm -rf .betterdesk-build rustdesk-source .betterdesk-toolchains')) {
        fail('decrypted inputs and transformed source must have unconditional workflow cleanup');
    }
    if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflow)) {
        fail('workflow must keep repository permissions at contents: read');
    }
    if (/pull_request_target|continue-on-error:\s*true|persist-credentials:\s*true/i.test(workflow)) {
        fail('workflow contains a prohibited privilege or failure-bypass setting');
    }
    if (!workflow.includes('ARTIFACT_RETENTION_DAYS: ${{ inputs.artifact_retention_days }}')
        || !workflow.includes('Number(r)<1||Number(r)>365')
        || !/^\s+retention-days:\s+\$\{\{ inputs\.artifact_retention_days \}\}\s*$/m.test(workflow)) {
        fail('workflow artifact retention must validate and preserve BetterDesk restart-recovery policy');
    }
    const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
    if (!actions.length) fail('workflow contains no Actions dependencies');
    for (const action of actions) {
        if (action.startsWith('./')) continue;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/i.test(action)) {
            fail(`GitHub Action is not pinned to an immutable commit: ${action}`);
        }
    }
    const repositoryCheck = workflow.indexOf('Verify complete central repository contract');
    const decrypt = workflow.indexOf('Decrypt and validate BetterDesk payload');
    if (repositoryCheck < 0 || decrypt < 0 || repositoryCheck >= decrypt) {
        fail('central repository verification must run before payload secrets are exposed');
    }
    return actions;
}

export async function verifyCentralRepository(rootDirectory = '.') {
    const root = await fs.realpath(path.resolve(rootDirectory));
    const gitRoot = await fs.realpath(git(root, ['rev-parse', '--show-toplevel']));
    if (root !== gitRoot) fail('verification path must be the root of the central Git repository');

    const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) fail('central repository checkout must be clean before a production build');

    const adapterRoot = path.join(root, '.betterdesk');
    const hashes = {};
    for (const name of REQUIRED_ADAPTER_FILES) {
        const file = path.join(adapterRoot, name);
        await regularFile(file, `.betterdesk/${name}`);
        hashes[name] = await sha256(file);
    }

    const workflowPath = path.join(root, '.github/workflows/real-client-build.yml');
    await regularFile(workflowPath, '.github/workflows/real-client-build.yml');
    const workflow = await fs.readFile(workflowPath, 'utf8');
    const actions = validateWorkflow(workflow);
    hashes['real-client-build.yml'] = await sha256(workflowPath);

    const adapterUrl = `${pathToFileURL(path.join(adapterRoot, 'build-real-client.mjs')).href}?admission=${Date.now()}`;
    const { describeBuildAdapter } = await import(adapterUrl);
    if (typeof describeBuildAdapter !== 'function') fail('build adapter does not export describeBuildAdapter()');
    const contract = describeBuildAdapter();
    if (contract?.schema !== 'betterdesk-real-client-adapter/v1') fail('build adapter schema is unsupported');
    if (!contract.sourceRevisions || !Object.keys(contract.sourceRevisions).length) {
        fail('build adapter contains no immutable RustDesk source revision');
    }

    const vendorRevisions = {};
    for (const vendor of VENDORS) {
        const directory = path.join(root, vendor.path);
        const stat = await fs.lstat(directory).catch((error) => {
            if (error.code === 'ENOENT') fail(`${vendor.name} checkout is missing at ${vendor.path}`);
            throw error;
        });
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${vendor.name} must be a real Git checkout`);
        const expected = String(contract.vendorRevisions?.[vendor.contractKey] || '').toLowerCase();
        const actual = git(directory, ['rev-parse', 'HEAD']).toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(expected) || actual !== expected) {
            fail(`${vendor.name} is at ${actual || 'an unknown revision'}, expected ${expected || 'a pinned revision'}`);
        }
        if (git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])) {
            fail(`${vendor.name} checkout must be clean`);
        }
        vendorRevisions[vendor.contractKey] = actual;
    }

    return {
        schema: 'betterdesk-central-repository-admission/v1',
        repositoryCommit: git(root, ['rev-parse', 'HEAD']).toLowerCase(),
        adapter: contract,
        vendorRevisions,
        actions,
        sha256: hashes,
    };
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
    try {
        const manifest = await verifyCentralRepository(process.argv[2] || '.');
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`Central repository verification failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
