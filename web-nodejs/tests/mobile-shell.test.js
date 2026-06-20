'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('mobile i18n keys', () => {
    const langDir = path.join(__dirname, '../lang');
    const locales = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));

    const requiredMobileNav = ['label', 'home', 'devices', 'remote', 'chat', 'more'];
    const requiredRemote = [
        'input_mode_touch',
        'input_mode_touchpad',
        'show_keyboard',
        'special_keys',
        'phone_unsupported_title',
        'phone_unsupported_body',
        'phone_unsupported_back_devices'
    ];

    for (const file of locales) {
        it(`${file} has mobile_nav and remote mobile keys`, () => {
            const data = JSON.parse(fs.readFileSync(path.join(langDir, file), 'utf8'));
            assert.ok(data.mobile_nav, `${file} missing mobile_nav`);
            for (const key of requiredMobileNav) {
                assert.ok(data.mobile_nav[key], `${file} mobile_nav.${key}`);
            }
            assert.ok(data.remote, `${file} missing remote`);
            for (const key of requiredRemote) {
                assert.ok(data.remote[key], `${file} remote.${key}`);
            }
        });
    }
});

describe('DeviceCapabilities', () => {
    it('exposes breakpoint constants and helpers', () => {
        const window = {
            innerWidth: 400,
            innerHeight: 800,
            navigator: { maxTouchPoints: 5 },
            matchMedia: () => ({ matches: false, media: 'not all', addEventListener: () => {} }),
            addEventListener: () => {},
            dispatchEvent: () => true
        };
        const sandbox = {
            window,
            document: {
                readyState: 'complete',
                body: { classList: { toggle: () => {}, contains: () => false } },
                documentElement: { clientWidth: 400 },
                addEventListener: () => {}
            },
            DeviceCapabilities: null
        };
        sandbox.global = window;
        const code = fs.readFileSync(path.join(__dirname, '../public/js/device-capabilities.js'), 'utf8');
        vm.runInNewContext(code, sandbox);
        const DC = sandbox.window.DeviceCapabilities;
        assert.strictEqual(DC.BP_PHONE, 767);
        assert.strictEqual(DC.isPhone(), true);
        window.innerWidth = 900;
        assert.strictEqual(DC.isTablet(), true);
    });
});
