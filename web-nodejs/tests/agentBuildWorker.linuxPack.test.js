'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('agentBuildWorker Linux packaging layout', () => {
    let worker;
    let tmpDir;

    beforeEach(() => {
        jest.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-linux-pack-'));
        process.env.BETTERDESK_DATA_DIR = tmpDir;
        worker = require('../services/agentBuildWorker');
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) { /* ok */ }
    });

    it('treats Wails single binary as non-dual layout', () => {
        const distDir = path.join(tmpDir, 'dist-single');
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, 'betterdesk-support'), 'bin');
        expect(worker._internals.hasDualLinuxUI(distDir)).toBe(false);
    });

    it('detects Fyne dual X11/Wayland layout', () => {
        const distDir = path.join(tmpDir, 'dist-dual');
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, 'betterdesk-support'), 'launcher');
        fs.writeFileSync(path.join(distDir, 'betterdesk-support-x11'), 'x11');
        fs.writeFileSync(path.join(distDir, 'betterdesk-support-wayland'), 'wl');
        expect(worker._internals.hasDualLinuxUI(distDir)).toBe(true);
    });

    it('stages only the single Wails binary when dual artifacts are absent', async () => {
        const distDir = path.join(tmpDir, 'dist-single');
        const stageDir = path.join(tmpDir, 'stage-single');
        fs.mkdirSync(distDir, { recursive: true });
        fs.mkdirSync(stageDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, 'betterdesk-support'), 'single-bin');

        const layout = await worker._internals.stageLinuxUI(distDir, stageDir, 'betterdesk-support');
        expect(layout).toBe('single');
        expect(fs.existsSync(path.join(stageDir, 'betterdesk-support'))).toBe(true);
        expect(fs.existsSync(path.join(stageDir, 'betterdesk-support-x11'))).toBe(false);
        expect(fs.existsSync(path.join(stageDir, 'betterdesk-support-wayland'))).toBe(false);
    });

    it('stages dual Fyne binaries when present', async () => {
        const distDir = path.join(tmpDir, 'dist-dual');
        const stageDir = path.join(tmpDir, 'stage-dual');
        fs.mkdirSync(distDir, { recursive: true });
        fs.mkdirSync(stageDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, 'betterdesk-support'), 'launcher');
        fs.writeFileSync(path.join(distDir, 'betterdesk-support-x11'), 'x11');
        fs.writeFileSync(path.join(distDir, 'betterdesk-support-wayland'), 'wl');

        const layout = await worker._internals.stageLinuxUI(distDir, stageDir, 'betterdesk-support');
        expect(layout).toBe('dual');
        expect(fs.readFileSync(path.join(stageDir, 'betterdesk-support-x11'), 'utf8')).toBe('x11');
        expect(fs.readFileSync(path.join(stageDir, 'betterdesk-support-wayland'), 'utf8')).toBe('wl');
    });

    it('needsCompile accepts a single Linux binary without x11/wayland companions', async () => {
        const workDir = path.join(tmpDir, 'work');
        const distDir = path.join(workDir, 'dist');
        fs.mkdirSync(distDir, { recursive: true });
        const binaryPath = path.join(distDir, 'betterdesk-support');
        fs.writeFileSync(binaryPath, 'bin');
        fs.writeFileSync(path.join(workDir, '.built_for'), 'fp-test');

        const needs = await worker._internals.needsCompile(workDir, 'fp-test', binaryPath, 'linux');
        expect(needs).toBe(false);
    });
});

describe('support-agent build.sh windows resource ordering', () => {
    it('generates winicon resources before sealbranding', () => {
        const buildSh = path.resolve(
            __dirname,
            '..',
            '..',
            'betterdesk-support-agent',
            'build.sh'
        );
        const src = fs.readFileSync(buildSh, 'utf8');
        const genIdx = src.indexOf('generate_windows_resources');
        // First executable call after the function definition — find the
        // standalone invocation (indented call, not the function keyword).
        const callMatch = src.match(/\nif \[ "\$TARGET_OS" = "windows" \]; then\n\s+generate_windows_resources\nfi/);
        expect(callMatch).not.toBeNull();
        const callIdx = callMatch.index;
        const sealIdx = src.indexOf('if seal_branding; then', callIdx);
        expect(sealIdx).toBeGreaterThan(callIdx);
        expect(genIdx).toBeGreaterThanOrEqual(0);
        // Ensure we do not call generate_windows_resources again after seal.
        const afterSeal = src.slice(sealIdx);
        expect(afterSeal).not.toMatch(/\ngenerate_windows_resources\n/);
    });
});
