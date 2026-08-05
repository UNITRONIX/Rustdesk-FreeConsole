'use strict';

const fs = require('fs');
const path = require('path');

describe('RustDesk Client Generator UI contract', () => {
    const root = path.join(__dirname, '..');
    const generator = fs.readFileSync(path.join(root, 'views', 'generator.ejs'), 'utf8');
    const partial = fs.readFileSync(path.join(root, 'views', 'partials', 'real-client-generator.ejs'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'public', 'js', 'real-client-generator.js'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'public', 'css', 'generator.css'), 'utf8');

    test('places RustDesk Client Generator as a full-width action below the compact bundle actions', () => {
        const bundle = generator.indexOf('id="gen-new-bundle"');
        const real = generator.indexOf('id="gen-new-real-client"');
        const support = generator.indexOf('id="gen-new-support"');
        const rdclient = generator.indexOf('id="gen-new-rdclient"');
        expect(bundle).toBeGreaterThan(-1);
        expect(support).toBeGreaterThan(bundle);
        expect(rdclient).toBeGreaterThan(support);
        expect(real).toBeGreaterThan(rdclient);
        expect(generator).toContain('class="generator-bundle-actions"');
        expect(styles).toMatch(/#gen-new-real-client\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1;[\s\S]*width:\s*100%;/);
        expect(generator).toContain('RustDesk Client Generator');
        expect(generator).toContain("pageScripts: ['generator', 'real-client-generator']");
    });

    test('exposes saved config, network, branding, policy, assets, build and history controls', () => {
        for (const id of [
            'rc-config-list', 'rc-name', 'rc-description', 'rc-organization', 'rc-version', 'rc-version-options', 'rc-target',
            'rc-id-server', 'rc-relay-server', 'rc-api-server', 'rc-public-key', 'rc-network-scope',
            'rc-app-name', 'rc-executable-name', 'rc-company-name', 'rc-android-id', 'rc-macos-bundle-id',
            'rc-asset-icon', 'rc-asset-logo',
            'rc-asset-privacy', 'rc-direction', 'rc-theme-scope', 'rc-permissions-scope',
            'rc-default-settings', 'rc-override-settings', 'rc-duplicate', 'rc-delete', 'rc-build',
            'rc-variant-selector', 'rc-build-matrix', 'rc-select-all-builds', 'rc-build-selection-summary',
            'rc-permanent-password', 'rc-build-history-title', 'rc-toggle-all-builds', 'rc-build-list',
        ]) expect(partial).toContain(`id="${id}"`);
        expect(partial).toContain('RustDesk Client Generator');
        expect(partial).toContain('One-click build matrix');
    });

    test('uses one API/business path and does not present an unregistered local provider', () => {
        expect(client).toContain('/api/generator/real-client/configs');
        expect(client).toContain('/api/generator/real-client/builds/batch');
        expect(client).toContain('/api/generator/real-client/build-plan');
        expect(client).toContain("new Set(['client', 'quicksupport'])");
        expect(client).not.toMatch(/<option[^>]+local/i);
        expect(partial).not.toMatch(/Own Server Build|LocalBuildProvider/);
    });

    test('shows target-specific warnings and automatic variant adjustments before dispatch', () => {
        expect(client).toContain('entry.warnings || []');
        expect(client).toContain('entry.adjustments || []');
        expect(client).toContain("'has-warning'");
        expect(client).toContain("'has-adjustment'");
        expect(client).toContain('Warning: ${warnings[0]}');
        expect(client).toContain('Planned: ${adjustments[0]}');
    });

    test('keeps detached build history accessible after its saved configuration is deleted', () => {
        expect(client).toContain('showAllBuilds: false');
        expect(client).toContain("?${query}");
        expect(client).toContain("'limit=500'");
        expect(client).toContain("build.config_id ? '' : ' · deleted'");
    });

    test('copies the resolved ID, relay, API and public key defaults into a new config', () => {
        expect(client).toContain("fresh.idServer = state.defaults.server_host || ''");
        expect(client).toContain("fresh.relayServer = state.defaults.relay_server || ''");
        expect(client).toContain("fresh.apiServer = state.defaults.api_url || ''");
        expect(client).toContain("fresh.publicKey = state.defaults.public_key || ''");
    });

    test('passes the fail-closed provider contract through every supported console Compose layout', () => {
        const repositoryRoot = path.resolve(root, '..');
        for (const name of [
            'docker-compose.yml',
            'docker-compose.single.yml',
            'docker-compose.quick.yml',
            'docker-compose.quick.single.yml',
            'docker-compose.quick.macvlan.yml',
            'docker-compose.quick.single.macvlan.yml',
        ]) {
            const compose = fs.readFileSync(path.join(repositoryRoot, name), 'utf8');
            expect({ name, github: compose.includes('REAL_CLIENT_GITHUB_TOKEN=') }).toEqual({ name, github: true });
            expect({ name, payload: compose.includes('REAL_CLIENT_PAYLOAD_PUBLIC_KEY=') }).toEqual({ name, payload: true });
            expect({ name, retention: compose.includes('REAL_CLIENT_ARTIFACT_RETENTION_DAYS=') }).toEqual({ name, retention: true });
        }
    });
});
