'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');

const LANG_DIR = path.resolve(path.join(__dirname, '..', 'lang'));
const REFERENCE_FILES = ['en.json', 'pl.json'];

function safeLangFilePath(code) {
    const sanitized = String(code || '').replace(/[^a-z-]/gi, '');
    if (!sanitized) {
        throw new Error('Invalid language code');
    }
    const langPath = path.resolve(LANG_DIR, `${sanitized}.json`);
    if (langPath !== LANG_DIR && !langPath.startsWith(LANG_DIR + path.sep)) {
        throw new Error('Invalid language path');
    }
    return langPath;
}

/**
 * Recursively flatten nested JSON object into dot-notation keys
 */
function flattenKeys(obj, prefix = '') {
    const result = new Map();
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of flattenKeys(value, fullKey)) {
                result.set(k, v);
            }
        } else {
            result.set(fullKey, String(value ?? ''));
        }
    }
    return result;
}

function loadReferenceKeys() {
    const references = new Map();
    const keySet = new Set();

    for (const file of REFERENCE_FILES) {
        const refPath = path.join(LANG_DIR, file);
        if (!fs.existsSync(refPath)) continue;

        const code = file.replace('.json', '');
        const data = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        const keys = flattenKeys(data);
        references.set(code, keys);
        for (const key of keys.keys()) keySet.add(key);
    }

    return { references, keySet };
}

// --- Page Route ---

router.get('/languages', requireAuth, requirePermission('server.config'), (req, res) => {
    res.render('languages', {
        title: req.t('nav.languages'),
        pageStyles: ['languages'],
        pageScripts: ['languages'],
        currentPage: 'languages',
        breadcrumb: [{ label: req.t('nav.languages') }]
    });
});

// --- API Routes ---

/**
 * GET /api/panel/languages — List all languages with coverage stats
 */
router.get('/api/panel/languages', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const { keySet: refKeySet } = loadReferenceKeys();
        if (refKeySet.size === 0) {
            return res.json({ languages: [], refKeyCount: 0 });
        }

        const langFiles = fs.readdirSync(LANG_DIR)
            .filter(f => f.endsWith('.json'))
            .sort();

        const languages = [];

        for (const file of langFiles) {
            const code = file.replace('.json', '');
            const filePath = path.join(LANG_DIR, file);

            let data;
            try {
                data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                languages.push({
                    code,
                    name: code,
                    native: code,
                    flag: '',
                    rtl: false,
                    needs_review: true,
                    is_reference: code === 'en' || code === 'pl',
                    total_keys: 0,
                    missing_keys: refKeySet.size,
                    extra_keys: 0,
                    empty_keys: 0,
                    coverage: 0,
                    error: e.message
                });
                continue;
            }

            const meta = data._meta || data.meta || {};
            const langKeys = flattenKeys(data);
            const langKeySet = new Set(langKeys.keys());

            const missing = [...refKeySet].filter(k => !langKeySet.has(k));
            const extra = [...langKeySet].filter(k => !refKeySet.has(k) && !k.startsWith('_meta') && !k.startsWith('meta.'));
            const empty = [...langKeySet].filter(k => refKeySet.has(k) && langKeys.get(k) === '');

            const coverage = code === 'en' ? 100
                : refKeySet.size > 0
                    ? Math.round(((refKeySet.size - missing.length) / refKeySet.size) * 100)
                    : 100;

            languages.push({
                code,
                name: meta.name || code,
                native: meta.native_name || meta.name || code,
                flag: meta.flag || '',
                rtl: meta.rtl || false,
                needs_review: meta.needs_review || false,
                is_reference: code === 'en' || code === 'pl',
                total_keys: langKeySet.size,
                missing_keys: code === 'en' || code === 'pl' ? 0 : missing.length,
                extra_keys: extra.length,
                empty_keys: empty.length,
                coverage,
                error: null
            });
        }

        res.json({ languages, refKeyCount: refKeySet.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load languages' });
    }
});

/**
 * GET /api/panel/languages/:code/missing — Get missing keys for a language
 */
router.get('/api/panel/languages/:code/missing', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const langPath = safeLangFilePath(req.params.code);

        if (!fs.existsSync(langPath)) {
            return res.status(404).json({ error: 'Language not found' });
        }

        const { references, keySet: refKeySet } = loadReferenceKeys();
        const langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));

        const langKeys = flattenKeys(langData);
        const langKeySet = new Set(langKeys.keys());

        const missing = [...refKeySet].filter(k => !langKeySet.has(k)).map(k => ({
            key: k,
            en_value: references.get('en')?.get(k) || '',
            pl_value: references.get('pl')?.get(k) || ''
        }));

        const extra = [...langKeySet].filter(k => !refKeySet.has(k) && !k.startsWith('_meta') && !k.startsWith('meta.'));

        res.json({ code, missing, extra, total: refKeySet.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to analyze language' });
    }
});

/**
 * POST /api/panel/languages/:code/fix — Disabled by strict i18n policy
 */
router.post('/api/panel/languages/:code/fix', uploadLimiter, requireAuth, requirePermission('server.config'), (req, res) => {
    res.status(410).json({
        error: 'Automatic language fixing is disabled. Missing keys must be translated manually in the target language.'
    });
});

module.exports = router;
