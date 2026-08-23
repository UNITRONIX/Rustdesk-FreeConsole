'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('UX 3.5 mobile and accessibility contracts', () => {
    const mobileCss = read('public', 'css', 'mobile-shell.css');
    const ux35Css = read('public', 'css', 'ux35.css');
    const shellJs = read('public', 'js', 'ux35-shell.js');
    const mobileJs = read('public', 'js', 'mobile-nav.js');
    const topbar = read('views', 'partials', 'ux35-topbar.ejs');
    const bottomNav = read('views', 'partials', 'mobile-bottom-nav.ejs');
    const sidebar = read('views', 'partials', 'ux35-sidebar.ejs');
    const layout = read('views', 'layouts', 'main.ejs');
    const automation = read('public', 'js', 'automation.js');
    const appJs = read('public', 'js', 'app.js');
    const notifCenter = read('public', 'js', 'notif-center.js');

    it('keeps classic mobile height rules out of the UX 3.5 scroll region', () => {
        assert.match(mobileCss, /\.app-layout \.main-content/);
        assert.match(mobileCss, /\.ux35-content\.main-content/);
        assert.match(mobileCss, /--ux35-topbar-height/);
    });

    it('uses a single UX 3.5 drawer from the mobile More control', () => {
        assert.match(mobileJs, /function isUx35Drawer/);
        assert.match(mobileJs, /setAttribute\('aria-controls', 'ux35-sidebar'\)/);
        assert.doesNotMatch(mobileJs, /\/\* UX 3\.5: full-list sidebar sections \*\//);
    });

    it('provides responsive action overflow and visible keyboard focus', () => {
        assert.match(topbar, /ux35-actions-menu-btn/);
        assert.match(topbar, /aria-controls="ux35-topbar-action-list"/);
        assert.match(ux35Css, /\.ux35-topbar-btn:focus-visible/);
        assert.match(ux35Css, /\.ux35-topbar-action-list\.is-open/);
    });

    it('makes drawer and sidebar resize interactions keyboard accessible', () => {
        assert.match(sidebar, /role="separator"/);
        assert.match(sidebar, /aria-valuemin="200"/);
        assert.match(shellJs, /focusableIn/);
        assert.match(shellJs, /e\.key === 'ArrowLeft'/);
        assert.match(shellJs, /sidebar\.inert/);
    });

    it('only renders aria-current for the active bottom navigation item', () => {
        assert.doesNotMatch(bottomNav, /aria-current="<%= .*: 'false' %>"/);
        assert.match(bottomNav, /aria-current="page"/);
    });

    it('escapes dynamic automation values before inserting rule rows', () => {
        assert.match(automation, /<td>\$\{escapeHtml\(r\.condition_value\)\}<\/td>/);
        assert.match(automation, /function safeSeverity/);
        assert.match(automation, /function safeStatus/);
    });

    it('defers console scripts without changing their document order', () => {
        assert.match(layout, /<script defer src="\/js\/utils\.js/);
        assert.match(layout, /<script defer src="\/js\/ux35-shell\.js/);
        assert.match(layout, /<script defer src="\/js\/<%= script %>\.js/);
    });

    it('keeps registration notifications visible without opening the registrations page', () => {
        assert.match(appJs, /\/ws\/panel-events/);
        assert.match(appJs, /registrations:pending-changed/);
        assert.match(appJs, /setInterval\(updateBadge, 15000\)/);
        assert.match(notifCenter, /data\.unread_count/);
        assert.match(notifCenter, /registration_pending/);
        assert.match(topbar, /id="notif-badge"/);
        assert.match(topbar, /href="\/registrations"/);
        assert.match(sidebar, /id="reg-sidebar-badge"/);
    });
});
