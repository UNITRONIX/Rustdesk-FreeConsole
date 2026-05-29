#!/usr/bin/env node
'use strict';

const readline = require('readline');
const updateService = require('../services/updateService');

const args = new Set(process.argv.slice(2));
const yes = args.has('--yes') || args.has('-y') || args.has('--auto');
const dryRun = args.has('--check') || args.has('--dry-run');
const createBackup = !args.has('--no-backup');

function getOptionValue(name, fallback) {
    const prefix = `${name}=`;
    const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

const serverStrategy = getOptionValue('--server-strategy', 'auto');

function step(index, total, message) {
    console.log(`[${index}/${total}] ${message}`);
}

function printComponents(components) {
    const entries = Object.entries(components || {}).filter(([, info]) => info.changed);
    if (!entries.length) return;
    console.log('Changed components:');
    for (const [name, info] of entries) {
        const mode = info.autoUpdate ? 'auto' : 'manual';
        console.log(`  - ${info.label || name}: ${info.fileCount || 0} file(s), ${mode}`);
    }
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function summarizeResult(result) {
    console.log('Update summary:');
    console.log(`  Applied: ${result.applied?.length || 0}`);
    console.log(`  Removed: ${result.removed?.length || 0}`);
    console.log(`  Skipped: ${result.skipped?.length || 0}`);
    console.log(`  Backup: ${result.backupPath || 'not created'}`);
    if (result.serverBuild) {
        console.log(`  Go server build: ${result.serverBuild.success ? 'ok' : 'failed'} (${result.serverBuild.method})`);
    }
    if (result.serverDeploy) {
        console.log(`  Go server deploy: ${result.serverDeploy.success ? 'ok' : 'failed'}`);
    }
    if (result.serverServiceConfig?.changed) {
        console.log(`  Service config: ${result.serverServiceConfig.changes.join('; ')}`);
    }
    if (result.toolchainInstall) {
        console.log(`  Go toolchain: ${result.toolchainInstall.success ? 'ready' : 'failed'}`);
    }
    if (result.failed?.length) {
        console.log('Failures:');
        for (const failure of result.failed) {
            console.log(`  - ${failure.file}: ${failure.error}`);
        }
    }
}

async function main() {
    console.log('BetterDesk terminal updater');
    console.log('Using the same update engine as the web console.');
    console.log('');

    step(1, 6, 'Checking remote update state');
    const check = await updateService.checkForUpdates();
    if (check.baselineEstablished) {
        console.log(`Baseline established at ${check.remoteSHA.slice(0, 7)}. No update applied.`);
        return;
    }
    if (!check.updateAvailable) {
        console.log(`Already up to date (${check.remoteSHA.slice(0, 7)}).`);
        return;
    }

    console.log(`Local SHA:  ${check.localSHA || 'unknown'}`);
    console.log(`Remote SHA: ${check.remoteSHA}`);
    console.log(`Commits behind: ${check.commitsBehind}`);
    printComponents(check.components);

    step(2, 6, 'Loading changed file list');
    const changedData = await updateService.getChangedFiles(check.remoteSHA);
    console.log(`Changed files: ${changedData.totalFiles}`);
    for (const commit of changedData.commits.slice(0, 5)) {
        console.log(`  - ${commit.sha} ${commit.message}`);
    }

    if (dryRun) {
        console.log('Dry run complete. No files were changed.');
        return;
    }

    if (!yes) {
        const answer = await ask('Apply this update now? [y/N] ');
        if (!/^y(es)?$/i.test(answer)) {
            console.log('Update cancelled.');
            return;
        }
    }

    step(3, 6, createBackup ? 'Creating backup and applying files' : 'Applying files without backup');
    const result = await updateService.applyUpdate(check.remoteSHA, changedData, {
        createBackup,
        serverStrategy
    });

    step(4, 6, 'Summarizing result');
    summarizeResult(result);

    // Distinguish critical failures (file download/write errors) from
    // non-critical ones (server binary not available — source was still
    // applied). See issue #154: server binary failures caused infinite
    // update loop because SHA was never saved.
    const NON_CRITICAL_FILES = new Set([
        'betterdesk-server', 'betterdesk-server-deploy', 'server-source'
    ]);
    const criticalFailures = (result.failed || []).filter(f => !NON_CRITICAL_FILES.has(f.file));
    const nonCriticalFailures = (result.failed || []).filter(f => NON_CRITICAL_FILES.has(f.file));

    if (criticalFailures.length) {
        console.log(`\n${criticalFailures.length} critical failure(s) — update incomplete.`);
        process.exitCode = 1;
        return;
    }
    if (nonCriticalFailures.length) {
        console.log(`\n${nonCriticalFailures.length} non-critical issue(s) (server binary not built/downloaded).`);
        console.log('Console and script files were applied successfully. Rebuild Go server manually if needed.');
    }

    step(5, 6, 'Restarting affected services');
    if (result.needsServerRestart) {
        const serviceName = process.platform === 'win32' ? 'BetterDeskServer' : 'betterdesk-server';
        const restart = updateService.restartService(serviceName);
        if (restart.success) console.log(`  - ${serviceName}: restarted`);
        else {
            console.log(`  - ${serviceName}: restart failed (${restart.error})`);
            process.exitCode = 1;
        }
    }
    if (result.needsConsoleRestart) {
        const serviceName = process.platform === 'win32' ? 'BetterDeskConsole' : 'betterdesk-console';
        const restart = updateService.restartService(serviceName);
        if (restart.success) console.log(`  - ${serviceName}: restarted`);
        else {
            console.log(`  - ${serviceName}: restart failed (${restart.error})`);
            process.exitCode = 1;
        }
    }
    if (!result.needsServerRestart && !result.needsConsoleRestart) {
        console.log('  - No service restart required');
    }

    step(6, 6, 'Done');
    if (result.shaSaved) {
        console.log(`Updated baseline SHA to ${check.remoteSHA.slice(0, 7)}.`);
    }
}

main().catch(err => {
    console.error(`Update failed: ${err.message}`);
    process.exitCode = 1;
});