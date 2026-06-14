/**
 * BetterDesk Console — mDNS panel discovery (optional)
 *
 * Publishes `_betterdesk._tcp` on the LAN so RdClient desktop can browse
 * for panels. Disable with PANEL_MDNS=off.
 *
 * UDP LAN discovery remains in lanDiscovery.js (port 21119).
 *
 * @module services/panelDiscovery
 */

'use strict';

const config = require('../config/config');
const { buildAnnouncement } = require('./lanDiscovery');

let bonjourInstance = null;
let published = null;

function panelPublicUrl() {
    const ann = buildAnnouncement();
    return ann.server.panelUrl || null;
}

function startPanelMdns() {
    if (process.env.PANEL_MDNS === 'off' || process.env.PANEL_MDNS === '0') {
        return null;
    }

    let Bonjour;
    try {
        Bonjour = require('bonjour-service').Bonjour;
    } catch (_) {
        console.warn('[panelDiscovery] bonjour-service not installed — mDNS disabled (UDP discovery still active)');
        return null;
    }

    if (bonjourInstance) return bonjourInstance;

    const panelUrl = panelPublicUrl();
    if (!panelUrl) return null;

    let parsed;
    try {
        parsed = new URL(panelUrl);
    } catch (_) {
        return null;
    }

    const port = parsed.port
        ? parseInt(parsed.port, 10)
        : (parsed.protocol === 'https:' ? 443 : 80);

    bonjourInstance = new Bonjour();
    published = bonjourInstance.publish({
        name: config.appName || 'BetterDesk',
        type: 'betterdesk',
        protocol: 'tcp',
        port,
        txt: {
            url: panelUrl.replace(/\/$/, ''),
            version: String(config.appVersion || ''),
        },
    });

    console.log(`  mDNS discovery published _betterdesk._tcp port ${port} (${panelUrl})`);
    return bonjourInstance;
}

function stopPanelMdns() {
    if (published) {
        try { published.stop(); } catch (_) { /* ignore */ }
        published = null;
    }
    if (bonjourInstance) {
        try { bonjourInstance.destroy(); } catch (_) { /* ignore */ }
        bonjourInstance = null;
    }
}

module.exports = {
    startPanelMdns,
    stopPanelMdns,
};
