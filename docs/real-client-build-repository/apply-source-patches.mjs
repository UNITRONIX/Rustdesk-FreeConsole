import fs from 'node:fs/promises';
import path from 'node:path';

const [planPath = '.betterdesk-build/input/build-plan.json', sourceRoot = 'rustdesk-source'] = process.argv.slice(2);
const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
if (plan.schema !== 'betterdesk-real-client-plan/v1') throw new Error('Unsupported build plan');
if (plan.sourcePatches?.customConfigVerification !== 'ed25519-required') {
    throw new Error('RustDesk custom-config signature verification must remain enabled');
}

async function replaceExactOnce(relativePath, before, after, label) {
    const file = path.resolve(sourceRoot, relativePath);
    const relative = path.relative(path.resolve(sourceRoot), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid ${label} source path`);
    const original = await fs.readFile(file, 'utf8');
    const oldMatches = original.split(before).length - 1;
    const newMatches = original.split(after).length - 1;
    if (oldMatches === 0 && newMatches === 1) return false;
    if (oldMatches !== 1 || newMatches !== 0) {
        throw new Error(`${label} is incompatible with this RustDesk revision (old=${oldMatches}, new=${newMatches})`);
    }
    const updated = original.replace(before, after);
    const temporary = `${file}.betterdesk-${process.pid}.tmp`;
    const mode = (await fs.stat(file)).mode & 0o777;
    try {
        await fs.writeFile(temporary, updated, { flag: 'wx', mode });
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return true;
}

async function requireExactOnce(relativePath, needle, label) {
    const file = path.resolve(sourceRoot, relativePath);
    const relative = path.relative(path.resolve(sourceRoot), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid ${label} source path`);
    const source = await fs.readFile(file, 'utf8');
    const matches = source.split(needle).length - 1;
    if (matches !== 1) throw new Error(`${label} is incompatible with this RustDesk revision (matches=${matches})`);
}

if (plan.sourcePatches?.connectionDelay === 'revision-guarded') {
    await replaceExactOnce(
        'src/client.rs',
        'if is_local || peer_nat_type == NatType::SYMMETRIC {',
        'if is_local || peer_nat_type == NatType::SYMMETRIC || !key.is_empty() {',
        'Third-party API connection-delay patch',
    );
} else if (plan.sourcePatches?.connectionDelay !== 'disabled') {
    throw new Error('Unsupported connection-delay patch policy');
}

if (plan.sourcePatches?.cycleMonitor === 'native-toolbar-setting') {
    await requireExactOnce(
        'flutter/lib/desktop/widgets/remote_toolbar.dart',
        `          pi.displaysCount.value > 1 &&\n          mainGetLocalBoolOptionSync(kOptionAllowMonitorSwitchMainToolbar)) {\n        return _MainMonitorSwitchButton(id: widget.id, ffi: widget.ffi);`,
        'Native main-toolbar monitor switch',
    );
    await requireExactOnce(
        'flutter/lib/desktop/widgets/remote_toolbar.dart',
        'class _MinimizedMonitorSwitchButton extends StatelessWidget {',
        'Native minimized-toolbar monitor switch',
    );
} else if (plan.sourcePatches?.cycleMonitor !== 'disabled') {
    throw new Error('Unsupported cycle-monitor policy');
}

if (plan.sourcePatches?.offlineIndicator === 'revision-guarded') {
    await replaceExactOnce(
        'flutter/lib/common/widgets/peer_card.dart',
        `          child: CircleAvatar(\n              radius: 3, backgroundColor: online ? Colors.green : kColorWarn)))`,
        `          child: online\n              ? CircleAvatar(radius: 3, backgroundColor: Colors.green)\n              : Icon(Icons.close, color: Colors.red, size: 12.0)))`,
        'Offline-indicator patch',
    );
} else if (plan.sourcePatches?.offlineIndicator !== 'disabled') {
    throw new Error('Unsupported offline-indicator patch policy');
}

if (plan.sourcePatches?.hideConnectionManager === 'revision-guarded') {
    await replaceExactOnce(
        'flutter/lib/desktop/pages/desktop_setting_page.dart',
        `            // if (usePassword)\n            //   hide_cm(!locked).marginOnly(left: _kContentHSubMargin - 6),`,
        `            if (usePassword)\n              hide_cm(!locked).marginOnly(left: _kContentHSubMargin - 6),`,
        'Hide-connection-manager settings control',
    );
    await replaceExactOnce(
        'flutter/lib/main.dart',
        '  gFFI.serverModel.hideCm = hide;',
        '  // BetterDesk: hideCm is derived from validated signed settings.',
        'Hide-connection-manager startup state',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        '  bool hideCm = false;',
        '  bool _hideCm = false;',
        'Hide-connection-manager private state',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `  bool get clipboardOk => _clipboardOk;\n\n  bool get showElevation => _showElevation;`,
        `  bool get clipboardOk => _clipboardOk;\n\n  bool get hideCm => _hideCm;\n\n  bool get showElevation => _showElevation;`,
        'Hide-connection-manager state getter',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `    /*\n    if (method != kUsePermanentPassword) {\n      await bind.mainSetOption(\n          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));\n    }\n    */`,
        `    // BetterDesk: hiding requires permanent-password verification.\n    if (method != kUsePermanentPassword) {\n      await bind.mainSetOption(\n          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));\n    }`,
        'Hide-connection-manager verification guard',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `    /*\n    if (mode != 'password') {\n      await bind.mainSetOption(\n          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));\n    }\n    */`,
        `    // BetterDesk: hiding requires password-only approval.\n    if (mode != 'password') {\n      await bind.mainSetOption(\n          key: 'allow-hide-cm', value: bool2option('allow-hide-cm', false));\n    }`,
        'Hide-connection-manager approval guard',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `    /*\n    // initital _hideCm at startup\n    final verificationMethod =\n        bind.mainGetOptionSync(key: kOptionVerificationMethod);\n    final approveMode = bind.mainGetOptionSync(key: kOptionApproveMode);\n    _hideCm = option2bool(\n        'allow-hide-cm', bind.mainGetOptionSync(key: 'allow-hide-cm'));\n    if (!(approveMode == 'password' &&\n        verificationMethod == kUsePermanentPassword)) {\n      _hideCm = false;\n    }\n    */`,
        `    // Initial _hideCm state comes only from the signed settings and\n    // remains constrained to permanent-password approval.\n    final verificationMethod =\n        bind.mainGetOptionSync(key: kOptionVerificationMethod);\n    final approveMode = bind.mainGetOptionSync(key: kOptionApproveMode);\n    _hideCm = option2bool(\n        'allow-hide-cm', bind.mainGetOptionSync(key: 'allow-hide-cm'));\n    if (!(approveMode == 'password' &&\n        verificationMethod == kUsePermanentPassword)) {\n      _hideCm = false;\n    }`,
        'Hide-connection-manager initial policy',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `    /*\n    var hideCm = option2bool(\n        'allow-hide-cm', await bind.mainGetOption(key: 'allow-hide-cm'));\n    if (!(approveMode == 'password' &&\n        verificationMethod == kUsePermanentPassword)) {\n      hideCm = false;\n    }\n    */`,
        `    // BetterDesk: refresh signed hide policy and re-check both guards.\n    var hideCm = option2bool(\n        'allow-hide-cm', await bind.mainGetOption(key: 'allow-hide-cm'));\n    if (!(approveMode == 'password' &&\n        verificationMethod == kUsePermanentPassword)) {\n      hideCm = false;\n    }`,
        'Hide-connection-manager refreshed policy',
    );
    await replaceExactOnce(
        'flutter/lib/models/server_model.dart',
        `    /*\n    if (_hideCm != hideCm) {\n      _hideCm = hideCm;\n      if (desktopType == DesktopType.cm) {\n        if (hideCm) {\n          await hideCmWindow();\n        } else {\n          await showCmWindow();\n        }\n      }\n      update = true;\n    }\n    */`,
        `    // BetterDesk: apply a validated hide-policy state transition.\n    if (_hideCm != hideCm) {\n      _hideCm = hideCm;\n      if (desktopType == DesktopType.cm) {\n        if (hideCm) {\n          await hideCmWindow();\n        } else {\n          await showCmWindow();\n        }\n      }\n      update = true;\n    }`,
        'Hide-connection-manager state refresh',
    );
} else if (plan.sourcePatches?.hideConnectionManager !== 'disabled') {
    throw new Error('Unsupported hide-connection-manager patch policy');
}

if (plan.sourcePatches?.removeVersionNotification === 'custom-client-native-guard') {
    await requireExactOnce(
        'flutter/lib/desktop/pages/desktop_home_page.dart',
        `    if (!bind.isCustomClient() &&\n        updateUrl.isNotEmpty &&`,
        'Custom-client update-notification guard',
    );
} else if (plan.sourcePatches?.removeVersionNotification !== 'disabled') {
    throw new Error('Unsupported update-notification policy');
}

process.stdout.write('Revision-guarded common RustDesk source patches applied.\n');
