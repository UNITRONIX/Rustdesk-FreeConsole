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

function loadDeviceCapabilities(opts) {
    opts = opts || {};
    const width = opts.width !== undefined ? opts.width : 400;
    const window = {
        innerWidth: width,
        innerHeight: opts.height || 800,
        navigator: { maxTouchPoints: opts.touch ? 5 : 0 },
        matchMedia: opts.matchMedia || (() => ({ matches: false, media: 'not all', addEventListener: () => {} })),
        visualViewport: opts.visualViewport || null,
        addEventListener: () => {},
        dispatchEvent: () => true
    };
    const sandbox = {
        window,
        document: {
            readyState: 'complete',
            body: { classList: { toggle: () => {}, contains: () => false } },
            documentElement: { clientWidth: width },
            addEventListener: () => {}
        },
        DeviceCapabilities: null
    };
    sandbox.global = window;
    const code = fs.readFileSync(path.join(__dirname, '../public/js/device-capabilities.js'), 'utf8');
    vm.runInNewContext(code, sandbox);
    return sandbox.window.DeviceCapabilities;
}

describe('DeviceCapabilities', () => {
    it('exposes breakpoint constants and helpers', () => {
        const DC = loadDeviceCapabilities({ width: 400, touch: true });
        assert.strictEqual(DC.BP_PHONE, 767);
        assert.strictEqual(DC.isPhone(), true);
        assert.strictEqual(DC.isTablet(), false);
    });

    it('isPhone() is false when width is 0 (pre-layout / WebView)', () => {
        const DC = loadDeviceCapabilities({ width: 0 });
        assert.strictEqual(DC.isPhone(), false);
    });

    it('isPhone() is false on desktop with fine pointer and hover', () => {
        const DC = loadDeviceCapabilities({
            width: 1920,
            matchMedia: (q) => ({
                matches: q === '(hover: hover) and (pointer: fine)',
                media: q,
                addEventListener: () => {}
            })
        });
        assert.strictEqual(DC.isPhone(), false);
    });

    it('isPhone() is true on small touch viewport without hover', () => {
        const DC = loadDeviceCapabilities({ width: 400, touch: true });
        assert.strictEqual(DC.isPhone(), true);
    });

    it('isPhone() is false on tablet width', () => {
        const DC = loadDeviceCapabilities({ width: 900, touch: true });
        assert.strictEqual(DC.isPhone(), false);
        assert.strictEqual(DC.isTablet(), true);
    });

    it('getWidth uses visualViewport when innerWidth is 0', () => {
        const DC = loadDeviceCapabilities({
            width: 0,
            visualViewport: { width: 820, height: 600, addEventListener: () => {} }
        });
        assert.strictEqual(DC.isPhone(), false);
        assert.strictEqual(DC.isTablet(), true);
    });
});
