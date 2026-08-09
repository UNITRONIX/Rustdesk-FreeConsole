#!/usr/bin/env node
'use strict';

/**
 * Small, dependency-free guardrail for the compatibility provenance process.
 * It intentionally validates only repository policy documents. It cannot
 * prove independent authorship and is not a substitute for legal review.
 */

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const repoRoot = join(__dirname, '..', '..');
const register = join(repoRoot, 'docs', 'important', 'support-agent-provenance.md');
const webRemotePlan = join(repoRoot, 'docs', 'features', 'WEB_REMOTE_CLIENT_PLAN.md');
const serverContext = join(repoRoot, '.github', 'go-server-context.md');
const notices = join(repoRoot, 'THIRD_PARTY_NOTICES.md');

const failures = [];

for (const file of [register, webRemotePlan, serverContext, notices]) {
    if (!existsSync(file)) failures.push(`Missing provenance policy file: ${file}`);
}

if (!failures.length) {
    const registerText = readFileSync(register, 'utf8');
    const webRemoteText = readFileSync(webRemotePlan, 'utf8');
    const serverContextText = readFileSync(serverContext, 'utf8');
    const noticesText = readFileSync(notices, 'utf8');

    if (!registerText.includes('Clean-room workflow')) {
        failures.push('The provenance register must define the clean-room workflow.');
    }
    if (!registerText.includes('Release gate')) {
        failures.push('The provenance register must define a release gate.');
    }
    if (!noticesText.includes('SBOM')) {
        failures.push('Third-party notices must describe the SBOM release requirement.');
    }
    if (/Copy `message\.proto` and `rendezvous\.proto` from `hbb_common\/protos`/i.test(webRemoteText)) {
        failures.push('The web remote plan still instructs contributors to copy external protocol schemas.');
    }
    if (/Use exact same \.proto files from hbb_common/i.test(webRemoteText)) {
        failures.push('The web remote plan still requires external protocol schema copies.');
    }
    if (/\.proto files .*have \*\*no copyright headers\*\*/i.test(serverContextText)) {
        failures.push('The Go server context still makes an unverified provenance claim.');
    }
}

if (failures.length) {
    console.error(`Clean-room provenance check failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
}

console.log('Clean-room provenance policy check passed.');
