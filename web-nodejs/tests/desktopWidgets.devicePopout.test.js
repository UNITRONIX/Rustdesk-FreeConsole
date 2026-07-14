'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function loadWidgetPlugins(devices) {
    const document = {
        createElement() {
            const element = { innerHTML: '' };
            Object.defineProperty(element, 'textContent', {
                set(value) { element.innerHTML = escapeHtml(value); },
            });
            return element;
        },
    };
    const sandbox = {
        console,
        document,
        Map,
        Date,
        Number,
        String,
        Utils: { api: jest.fn(() => Promise.resolve({ devices })) },
        _: (key) => ({
            'devices.connected': 'Connected',
            'devices.disconnected': 'Disconnected',
            'devices.connected_for': 'Connected for',
        }[key] || key),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const filename = path.join(__dirname, '../public/js/widget-plugins.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.WidgetPlugins;
}

describe('Device List widget popout presentation', () => {
    test('renders connected devices first with an exact compact duration', async () => {
        const plugins = loadWidgetPlugins([
            { id: 'OFFLINE1', hostname: 'alpha', platform: 'Linux', online: false },
            { id: 'ONLINE1', hostname: 'office-pc', platform: 'Windows 11', online: true, online_seconds: 93784 },
        ]);
        const list = { innerHTML: '' };
        const body = { querySelector: (selector) => selector === '.widget-device-list' ? list : null };

        plugins.get('device-list').update(body);
        await new Promise(resolve => setImmediate(resolve));

        expect(list.innerHTML.indexOf('ONLINE1')).toBeLessThan(list.innerHTML.indexOf('OFFLINE1'));
        expect(list.innerHTML).toContain('Connected');
        expect(list.innerHTML).toContain('1d 02h 03m');
        expect(list.innerHTML).toContain('Disconnected');
        expect(list.innerHTML).toContain('widget-device-identity');
    });

    test('escapes device names used in popup title attributes', async () => {
        const plugins = loadWidgetPlugins([
            { id: 'SAFE1', hostname: 'office"<pc', online: true, online_seconds: 60 },
        ]);
        const list = { innerHTML: '' };
        const body = { querySelector: () => list };

        plugins.get('device-list').update(body);
        await new Promise(resolve => setImmediate(resolve));

        expect(list.innerHTML).toContain('title="office&quot;&lt;pc"');
        expect(list.innerHTML).not.toContain('title="office"<pc"');
    });

    test('popup loads the complete widget stylesheet and includes a device-list fallback', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/js/desktop-widgets.js'),
            'utf8'
        );
        expect(source).toContain('link[href*="/css/desktop-widgets.css"]');
        expect(source).toContain("'<link rel=\"stylesheet\" href=\"' + escAttr(widgetStylesheetHref)");
        expect(source).toContain("'.widget-device-row { display:grid;");
    });
});
