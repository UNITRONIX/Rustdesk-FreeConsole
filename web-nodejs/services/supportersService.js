/**
 * BetterDesk Console — project supporters list for the Help panel.
 * Mirrors SPONSORS.md via config/supporters.json (manual sync).
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'supporters.json');

const EMPTY = Object.freeze({
    honorary: [],
    individuals: [],
    links: {
        repo: 'https://github.com/UNITRONIX/BetterDesk',
        issues: 'https://github.com/UNITRONIX/BetterDesk/issues',
        sponsors: 'https://github.com/sponsors/UNITRONIX',
        buyMeACoffee: 'https://buymeacoffee.com/unitronix',
        sponsorsMd: 'https://github.com/UNITRONIX/BetterDesk/blob/main/SPONSORS.md'
    }
});

let _cache = null;

function loadSupporters() {
    if (_cache) return _cache;
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const data = JSON.parse(raw);
        _cache = {
            honorary: Array.isArray(data.honorary) ? data.honorary : [],
            individuals: Array.isArray(data.individuals) ? data.individuals : [],
            links: { ...EMPTY.links, ...(data.links && typeof data.links === 'object' ? data.links : {}) }
        };
    } catch (err) {
        console.warn('[supportersService] Failed to load supporters.json:', err.message);
        _cache = { ...EMPTY, honorary: [], individuals: [], links: { ...EMPTY.links } };
    }
    return _cache;
}

/** Clear in-memory cache (tests / hot reload). */
function resetCache() {
    _cache = null;
}

module.exports = {
    loadSupporters,
    resetCache
};
