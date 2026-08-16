#!/usr/bin/env node
'use strict';

/**
 * Arm Windows console revival using the on-disk helper.
 * Invoked from security-patch-verify after panel file apply so even an
 * older in-memory updateService can recover interactive npm installs.
 */

const path = require('path');

if (process.platform !== 'win32') {
    process.exit(0);
}

const consoleRoot = path.join(__dirname, '..');
const helperPath = path.join(consoleRoot, 'lib', 'windowsConsoleSelfRestart.js');

try {
    const helper = require(helperPath);
    const prepared = helper.prepareWindowsConsoleRestart({
        consoleRoot,
        reason: 'security-patch-verify',
        delaySec: 3,
    });
    const mode = prepared && prepared.mode;
    if (mode === 'interactive-reexec' || mode === 'service-fallback-reexec') {
        if (prepared.reexec && prepared.reexec.spawned) {
            console.log(
                `PASS  windowsConsoleRestart: armed ${mode}`
                + (prepared.reexec.delaySec ? ` (delay ${prepared.reexec.delaySec}s)` : '')
            );
            process.exit(0);
        }
        console.error(`FAIL  windowsConsoleRestart: ${prepared.reexec && prepared.reexec.error || 'spawn failed'}`);
        process.exit(0); // non-fatal for security verify
    }
    if (prepared && prepared.scheduled && prepared.scheduled.scheduled) {
        console.log(`PASS  windowsConsoleRestart: armed NSSM start of ${prepared.scheduled.service}`);
        process.exit(0);
    }
    console.log(`PASS  windowsConsoleRestart: mode=${mode || 'none'}`);
} catch (err) {
    console.error(`FAIL  windowsConsoleRestart: ${err.message || err}`);
    process.exit(0); // non-fatal
}
