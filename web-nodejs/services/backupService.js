/**
 * BetterDesk Console - Backup & Restore Service
 *
 * Creates/restores JSON snapshots of console configuration:
 *   - Console settings (key/value pairs)
 *   - Branding configuration
 *   - Users (admin/operator accounts — passwords are hashed)
 *   - Folders structure
 *   - User groups, device groups, strategies
 *   - Address books
 *   - Go server peers + blocklist + config (fetched via REST when available)
 *
 * Archive format: single JSON file (*.betterdesk-backup.json)
 */

const db = require('./database');
const brandingService = require('./brandingService');
const serverBackend = require('./serverBackend');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const archive = require('./backupArchive');

// Current backup format version — increment on breaking schema changes
const BACKUP_FORMAT_VERSION = 1;

// Full disaster-recovery archive format identifier + version
const FULL_BACKUP_FORMAT = 'betterdesk-full-backup';
const FULL_BACKUP_VERSION = 1;

// ========================== Export ========================================

/**
 * Build a full backup payload.
 * @returns {Promise<Object>} Serialisable backup object
 */
async function createBackup() {
    const timestamp = new Date().toISOString();

    // --- Console local data ---
    const settings = await db.getAllSettings();
    const branding = brandingService.getBranding();
    const users = await db.getAllUsersForBackup();
    const folders = await db.getAllFolders();
    const userGroups = await db.getAllUserGroups();
    const deviceGroups = await db.getAllDeviceGroups();
    const strategies = await db.getAllStrategies();

    // Address books (all users)
    const addressBooks = await db.getAllAddressBooks();

    // --- Go server data (best-effort) ---
    let goServer = null;
    if (serverBackend.isBetterDesk()) {
        goServer = await fetchGoServerData();
    }

    return {
        _format: 'betterdesk-backup',
        _version: BACKUP_FORMAT_VERSION,
        _created: timestamp,
        _console_version: config.appVersion,
        _backend: serverBackend.getActiveBackend(),
        console: {
            settings,
            branding,
            users,
            folders,
            userGroups,
            deviceGroups,
            strategies,
            addressBooks
        },
        goServer
    };
}

/**
 * Fetch data from BetterDesk Go server via REST API.
 * Non-critical — returns null on failure.
 */
async function fetchGoServerData() {
    try {
        const betterdeskApi = require('./betterdeskApi');
        const [peersRes, blocklistRes, auditRes, healthRes] = await Promise.all([
            betterdeskApi.getAllPeers().catch(() => []),
            betterdeskApi.getBlocklist().catch(() => []),
            betterdeskApi.getAuditEvents(500).catch(() => []),
            betterdeskApi.getHealth().catch(() => ({}))
        ]);

        return {
            peers: peersRes || [],
            blocklist: blocklistRes || [],
            auditEvents: auditRes || [],
            serverHealth: healthRes || {}
        };
    } catch {
        return null;
    }
}

// ========================== Import ========================================

/**
 * Validate a backup payload before restoring.
 * @param {Object} data - Parsed backup JSON
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateBackup(data) {
    const errors = [];

    if (!data || typeof data !== 'object') {
        errors.push('Invalid backup file: not a JSON object');
        return { valid: false, errors };
    }
    if (data._format !== 'betterdesk-backup') {
        errors.push('Invalid backup file: missing or wrong _format field');
    }
    if (typeof data._version !== 'number' || data._version > BACKUP_FORMAT_VERSION) {
        errors.push(`Unsupported backup version: ${data._version} (max supported: ${BACKUP_FORMAT_VERSION})`);
    }
    if (!data.console || typeof data.console !== 'object') {
        errors.push('Invalid backup file: missing console section');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Restore console data from a backup payload.
 * Only restores console-local data. Go server data is informational.
 *
 * @param {Object} data - Validated backup payload
 * @param {Object} options
 * @param {boolean} options.restoreSettings   - Restore console settings (default true)
 * @param {boolean} options.restoreBranding   - Restore branding/theme (default true)
 * @param {boolean} options.restoreUsers      - Restore user accounts (default false — destructive!)
 * @param {boolean} options.restoreFolders    - Restore folder structure (default true)
 * @param {boolean} options.restoreGroups     - Restore user/device groups + strategies (default true)
 * @param {boolean} options.restoreAddressBooks - Restore address books (default true)
 * @returns {{ restored: string[], skipped: string[], warnings: string[] }}
 */
async function restoreBackup(data, options = {}) {
    const {
        restoreSettings = true,
        restoreBranding = true,
        restoreUsers = false,
        restoreFolders = true,
        restoreGroups = true,
        restoreAddressBooks = true
    } = options;

    const result = { restored: [], skipped: [], warnings: [] };

    // --- Settings ---
    if (restoreSettings && data.console.settings) {
        try {
            const settings = data.console.settings;
            for (const [key, value] of Object.entries(settings)) {
                await db.setSetting(key, value);
            }
            result.restored.push('settings');
        } catch (err) {
            result.warnings.push(`Settings restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('settings');
    }

    // --- Branding ---
    if (restoreBranding && data.console.branding) {
        try {
            await brandingService.saveBranding(data.console.branding);
            result.restored.push('branding');
        } catch (err) {
            result.warnings.push(`Branding restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('branding');
    }

    // --- Users (destructive — replaces all users) ---
    if (restoreUsers && Array.isArray(data.console.users) && data.console.users.length > 0) {
        try {
            await db.restoreUsers(data.console.users);
            result.restored.push('users');
        } catch (err) {
            result.warnings.push(`Users restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('users');
    }

    // --- Folders ---
    if (restoreFolders && Array.isArray(data.console.folders)) {
        try {
            // Merge: insert folders that don't exist
            const existingFolders = await db.getAllFolders();
            const existing = new Set(existingFolders.map(f => f.name));
            for (const f of data.console.folders) {
                if (!existing.has(f.name)) {
                    await db.createFolder(f.name, f.color || '#6366f1', f.icon || 'folder');
                }
            }
            result.restored.push('folders');
        } catch (err) {
            result.warnings.push(`Folders restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('folders');
    }

    // --- User Groups + Device Groups + Strategies ---
    if (restoreGroups) {
        try {
            await restoreGroupsData(data.console, result);
            result.restored.push('groups');
        } catch (err) {
            result.warnings.push(`Groups restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('groups');
    }

    // --- Address Books ---
    if (restoreAddressBooks && Array.isArray(data.console.addressBooks)) {
        try {
            for (const ab of data.console.addressBooks) {
                if (ab.user_id && ab.ab_type) {
                    await db.saveAddressBook(ab.user_id, ab.ab_type, ab.data || '{}');
                }
            }
            result.restored.push('addressBooks');
        } catch (err) {
            result.warnings.push(`Address books restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('addressBooks');
    }

    return result;
}

/**
 * Restore user groups, device groups and strategies (merge, don't duplicate).
 */
async function restoreGroupsData(consoleData, result) {
    // User groups
    if (Array.isArray(consoleData.userGroups)) {
        const existing = new Set((await db.getAllUserGroups()).map(g => g.guid));
        for (const g of consoleData.userGroups) {
            if (g.guid && !existing.has(g.guid)) {
                try {
                    await db.createUserGroup({ guid: g.guid, name: g.name, note: g.note || '' });
                } catch { /* duplicate guid — skip */ }
            }
        }
    }

    // Device groups
    if (Array.isArray(consoleData.deviceGroups)) {
        const existing = new Set((await db.getAllDeviceGroups()).map(g => g.guid));
        for (const g of consoleData.deviceGroups) {
            if (g.guid && !existing.has(g.guid)) {
                try {
                    await db.createDeviceGroup({ guid: g.guid, name: g.name, note: g.note || '' });
                } catch { /* duplicate guid — skip */ }
            }
        }
    }

    // Strategies
    if (Array.isArray(consoleData.strategies)) {
        const existing = new Set((await db.getAllStrategies()).map(s => s.guid));
        for (const s of consoleData.strategies) {
            if (s.guid && !existing.has(s.guid)) {
                try {
                    await db.createStrategy({
                        guid: s.guid,
                        name: s.name,
                        user_group_guid: s.user_group_guid || '',
                        device_group_guid: s.device_group_guid || '',
                        enabled: s.enabled !== undefined ? s.enabled : 1,
                        permissions: typeof s.permissions === 'string' ? s.permissions : JSON.stringify(s.permissions || {})
                    });
                } catch { /* duplicate guid — skip */ }
            }
        }
    }
}

/**
 * Get size estimate for a backup (useful for UI info).
 * @returns {{ tables: Object<string, number>, totalRows: number }}
 */
async function getBackupStats() {
    const stats = await db.getBackupStats();
    return {
        ...stats,
        backend: serverBackend.getActiveBackend()
    };
}

// ===================== Full Disaster-Recovery Backup ======================
//
// Unlike the JSON snapshot above, the full backup bundles everything required
// to rebuild the server identity and data on a brand-new machine:
//   - manifest.json                  metadata + component inventory
//   - console/data.json              logical dump of ALL console DB tables
//   - console/auth.db                raw SQLite copy (sqlite backend only)
//   - console/.env                   environment (SESSION_SECRET, API key, DSN, ports, TLS)
//   - console/.session_secret        session signing secret
//   - console/uploads/*              branding image files
//   - goserver/data.json            Go server peers/blocklist/audit (informational)
//   - goserver/id_ed25519(.pub)      server identity keypair (client trust + relay)
//   - goserver/.api_key              console <-> Go server API key
//   - goserver/db_v2.sqlite3         raw Go server DB (when readable)
//   - README.txt                     human-readable recovery instructions
//
// SECURITY: the archive contains secrets (keys, .env, password hashes, 2FA
// secrets). It MUST be stored securely and never shared. The UI warns about
// this and most secret components require an explicit opt-in to restore.

/**
 * Resolve the absolute paths of every file-based backup component.
 */
function resolveBackupPaths() {
    return {
        env: path.join(__dirname, '..', '.env'),
        sessionSecret: path.join(config.dataDir, '.session_secret'),
        uploadsDir: path.join(config.dataDir, 'uploads'),
        consoleDb: db.getDatabaseFilePath(),
        goPrivKey: path.join(config.keysPath, 'id_ed25519'),
        goPubKey: config.pubKeyPath,
        goApiKey: config.apiKeyPath,
        goDb: config.dbPath
    };
}

/**
 * Add a file to the archive entry list if it exists and is readable.
 */
function addFileIfExists(entries, archiveName, filePath, present) {
    try {
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            entries.push({ name: archiveName, data: fs.readFileSync(filePath), mode: 0o600 });
            present.push(archiveName);
            return true;
        }
    } catch (_) { /* unreadable — skip */ }
    return false;
}

/**
 * Recursively collect files under a directory into archive entries.
 */
function addDirIfExists(entries, archivePrefix, dirPath, present) {
    try {
        if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
        const walk = (rel) => {
            const abs = path.join(dirPath, rel);
            for (const name of fs.readdirSync(abs)) {
                const childRel = rel ? path.join(rel, name) : name;
                const childAbs = path.join(dirPath, childRel);
                const st = fs.statSync(childAbs);
                if (st.isDirectory()) {
                    walk(childRel);
                } else if (st.isFile()) {
                    const archiveName = `${archivePrefix}/${childRel.split(path.sep).join('/')}`;
                    entries.push({ name: archiveName, data: fs.readFileSync(childAbs), mode: 0o644 });
                    present.push(archiveName);
                }
            }
        };
        walk('');
    } catch (_) { /* skip */ }
}

/**
 * Build the human-readable recovery instructions bundled in the archive.
 */
function buildRecoveryReadme(manifest) {
    return [
        'BetterDesk Console — Full Disaster-Recovery Backup',
        '==================================================',
        '',
        `Created:          ${manifest._created}`,
        `Console version:  ${manifest._console_version}`,
        `Database engine:  ${manifest.dbType}`,
        `Components:        ${manifest.components.join(', ')}`,
        '',
        'WARNING: This archive contains SECRETS (Ed25519 server keys, .env with',
        'SESSION_SECRET / API key / database credentials, user password hashes and',
        '2FA secrets). Store it securely and never share it.',
        '',
        'How to restore on a fresh machine',
        '---------------------------------',
        '1. Install BetterDesk using the ALL-IN-ONE installer (betterdesk.sh / .ps1).',
        '2. Stop the console and Go server services.',
        '3. Open the web console Settings page and use "Restore from backup",',
        '   OR extract this archive manually with: tar -xzf <backup>.tar.gz',
        '   and copy each component back to its location:',
        '     console/.env            -> web-nodejs/.env',
        '     console/.session_secret -> <dataDir>/.session_secret',
        '     console/auth.db         -> <dataDir>/auth.db   (SQLite backend only)',
        '     console/uploads/*       -> <dataDir>/uploads/',
        '     goserver/id_ed25519     -> <keysPath>/id_ed25519',
        '     goserver/id_ed25519.pub -> <keysPath>/id_ed25519.pub',
        '     goserver/.api_key       -> <keysPath>/.api_key',
        '     goserver/db_v2.sqlite3  -> Go server DB path (SQLite backend only)',
        '4. For PostgreSQL backends, the logical dump in console/data.json is',
        '   re-imported through the console Restore action.',
        '5. Restart both services. Clients keep trusting the server because the',
        '   Ed25519 identity key was preserved.',
        ''
    ].join('\n');
}

/**
 * Create a full disaster-recovery backup as a gzipped tar archive.
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function createFullBackup() {
    const timestamp = new Date().toISOString();
    const paths = resolveBackupPaths();
    const entries = [];
    const present = [];

    // --- Console logical DB dump (portable across engines) ---
    let consoleDump = null;
    try { consoleDump = await db.dumpAllTables(); } catch (_) { consoleDump = null; }
    if (consoleDump) {
        entries.push({ name: 'console/data.json', data: JSON.stringify(consoleDump) });
        present.push('console/data.json');
    }

    // --- Go server data (best-effort, informational) ---
    let goServer = null;
    if (await serverBackend.isBetterDesk()) {
        goServer = await fetchGoServerData();
    }
    if (goServer) {
        entries.push({ name: 'goserver/data.json', data: JSON.stringify(goServer) });
        present.push('goserver/data.json');
    }

    // --- Raw secret / identity files ---
    addFileIfExists(entries, 'console/.env', paths.env, present);
    addFileIfExists(entries, 'console/.session_secret', paths.sessionSecret, present);
    addFileIfExists(entries, 'console/auth.db', paths.consoleDb, present);
    addDirIfExists(entries, 'console/uploads', paths.uploadsDir, present);
    addFileIfExists(entries, 'goserver/id_ed25519', paths.goPrivKey, present);
    addFileIfExists(entries, 'goserver/id_ed25519.pub', paths.goPubKey, present);
    addFileIfExists(entries, 'goserver/.api_key', paths.goApiKey, present);
    addFileIfExists(entries, 'goserver/db_v2.sqlite3', paths.goDb, present);

    // --- Manifest + README ---
    const manifest = {
        _format: FULL_BACKUP_FORMAT,
        _version: FULL_BACKUP_VERSION,
        _created: timestamp,
        _console_version: config.appVersion,
        _backend: await serverBackend.getActiveBackend(),
        dbType: config.dbType,
        components: present
    };
    entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    entries.push({ name: 'README.txt', data: buildRecoveryReadme(manifest) });

    const buffer = archive.createTarGz(entries);
    const dateStr = timestamp.slice(0, 19).replace(/[:T]/g, '-');
    return { buffer, filename: `betterdesk-backup-${dateStr}.tar.gz` };
}

/**
 * Validate a full-backup archive buffer.
 * @returns {{ valid: boolean, errors: string[], manifest: Object|null }}
 */
function validateFullBackup(buffer) {
    const errors = [];
    let files;
    try {
        files = archive.extractTarGz(buffer);
    } catch (err) {
        return { valid: false, errors: [`Not a valid gzip/tar archive: ${err.message}`], manifest: null };
    }
    const manifestRaw = files.get('manifest.json');
    if (!manifestRaw) {
        return { valid: false, errors: ['Archive is missing manifest.json'], manifest: null };
    }
    let manifest;
    try {
        manifest = JSON.parse(manifestRaw.toString('utf8'));
    } catch (err) {
        return { valid: false, errors: [`manifest.json is not valid JSON: ${err.message}`], manifest: null };
    }
    if (manifest._format !== FULL_BACKUP_FORMAT) {
        errors.push('Archive is not a BetterDesk full backup (wrong _format)');
    }
    if (typeof manifest._version !== 'number' || manifest._version > FULL_BACKUP_VERSION) {
        errors.push(`Unsupported full-backup version: ${manifest._version}`);
    }
    return { valid: errors.length === 0, errors, manifest, files };
}

/**
 * Restore a full disaster-recovery backup.
 *
 * @param {Buffer} buffer - gzipped tar archive
 * @param {Object} options
 * @param {boolean} options.restoreDatabase  - Re-import logical DB dump (default true)
 * @param {boolean} options.restoreEnv       - Overwrite .env (default false — needs restart)
 * @param {boolean} options.restoreSecrets   - Restore session secret + Go keys + API key (default false)
 * @param {boolean} options.restoreUploads   - Restore branding upload files (default true)
 * @param {boolean} options.restoreGoDb      - Overwrite Go server raw DB (default false — needs restart)
 * @returns {Promise<{ restored: string[], skipped: string[], warnings: string[], requiresRestart: boolean }>}
 */
async function restoreFullBackup(buffer, options = {}) {
    const {
        restoreDatabase = true,
        restoreEnv = false,
        restoreSecrets = false,
        restoreUploads = true,
        restoreGoDb = false
    } = options;

    const result = { restored: [], skipped: [], warnings: [], requiresRestart: false };

    const validation = validateFullBackup(buffer);
    if (!validation.valid) {
        throw new Error(`Invalid backup archive: ${validation.errors.join('; ')}`);
    }
    const files = validation.files;
    const paths = resolveBackupPaths();

    const writeFile = (filePath, data, mode) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, data, { mode: mode || 0o600 });
    };

    // --- Logical DB import (live restore, no restart needed) ---
    if (restoreDatabase && files.has('console/data.json')) {
        try {
            const dump = JSON.parse(files.get('console/data.json').toString('utf8'));
            const r = await db.importAllTables(dump);
            result.restored.push(`database (${r.restored.length} tables)`);
            for (const w of r.warnings) result.warnings.push(w);
        } catch (err) {
            result.warnings.push(`Database restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('database');
    }

    // --- Branding upload files ---
    if (restoreUploads) {
        try {
            let count = 0;
            for (const [name, data] of files) {
                if (name.startsWith('console/uploads/')) {
                    const rel = name.slice('console/uploads/'.length);
                    if (!rel || rel.includes('..')) continue;
                    writeFile(path.join(paths.uploadsDir, rel), data, 0o644);
                    count++;
                }
            }
            if (count > 0) result.restored.push(`uploads (${count} files)`);
            else result.skipped.push('uploads');
        } catch (err) {
            result.warnings.push(`Uploads restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('uploads');
    }

    // --- Secrets: session secret, Go identity keys, API key (needs restart) ---
    if (restoreSecrets) {
        const secretFiles = [
            ['console/.session_secret', paths.sessionSecret, 0o600],
            ['goserver/id_ed25519', paths.goPrivKey, 0o600],
            ['goserver/id_ed25519.pub', paths.goPubKey, 0o644],
            ['goserver/.api_key', paths.goApiKey, 0o600]
        ];
        let restoredAny = false;
        for (const [archiveName, target, mode] of secretFiles) {
            if (files.has(archiveName) && target) {
                try {
                    writeFile(target, files.get(archiveName), mode);
                    restoredAny = true;
                } catch (err) {
                    result.warnings.push(`${archiveName} restore failed: ${err.message}`);
                }
            }
        }
        if (restoredAny) { result.restored.push('secrets/keys'); result.requiresRestart = true; }
        else result.skipped.push('secrets/keys');
    } else {
        result.skipped.push('secrets/keys');
    }

    // --- .env (needs restart) ---
    if (restoreEnv && files.has('console/.env')) {
        try {
            writeFile(paths.env, files.get('console/.env'), 0o600);
            result.restored.push('.env');
            result.requiresRestart = true;
        } catch (err) {
            result.warnings.push(`.env restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('.env');
    }

    // --- Go server raw DB (SQLite only, needs restart) ---
    if (restoreGoDb && files.has('goserver/db_v2.sqlite3') && paths.goDb) {
        try {
            writeFile(paths.goDb, files.get('goserver/db_v2.sqlite3'), 0o600);
            result.restored.push('goserver-db');
            result.requiresRestart = true;
        } catch (err) {
            result.warnings.push(`Go server DB restore failed: ${err.message}`);
        }
    } else {
        result.skipped.push('goserver-db');
    }

    return result;
}

/**
 * Stats / inventory for the full backup UI.
 */
async function getFullBackupStats() {
    const stats = await db.getBackupStats();
    const paths = resolveBackupPaths();
    const exists = (p) => {
        try { return !!p && fs.existsSync(p); } catch (_) { return false; }
    };
    let uploadCount = 0;
    try {
        if (exists(paths.uploadsDir)) {
            const walk = (dir) => {
                for (const name of fs.readdirSync(dir)) {
                    const abs = path.join(dir, name);
                    const st = fs.statSync(abs);
                    if (st.isDirectory()) walk(abs);
                    else if (st.isFile()) uploadCount++;
                }
            };
            walk(paths.uploadsDir);
        }
    } catch (_) { /* ignore */ }
    return {
        ...stats,
        backend: await serverBackend.getActiveBackend(),
        dbType: config.dbType,
        components: {
            env: exists(paths.env),
            sessionSecret: exists(paths.sessionSecret),
            consoleDb: exists(paths.consoleDb),
            uploads: uploadCount,
            goPrivKey: exists(paths.goPrivKey),
            goPubKey: exists(paths.goPubKey),
            goApiKey: exists(paths.goApiKey),
            goDb: exists(paths.goDb)
        }
    };
}

module.exports = {
    createBackup,
    validateBackup,
    restoreBackup,
    getBackupStats,
    BACKUP_FORMAT_VERSION,
    createFullBackup,
    restoreFullBackup,
    getFullBackupStats,
    validateFullBackup,
    FULL_BACKUP_FORMAT,
    FULL_BACKUP_VERSION
};
