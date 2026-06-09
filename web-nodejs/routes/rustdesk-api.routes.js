/**
 * BetterDesk Console - RustDesk Client API Routes
 * 
 * RustDesk-compatible API endpoints.
 * Runs on a dedicated port (default 21121) for WAN access.
 * 
 * Protocol Reference — Phase 1 (Core):
 *   POST /api/login           - Authenticate (username+password or TFA code)
 *   POST /api/logout          - Revoke token
 *   GET  /api/currentUser     - Get current user info (Bearer auth)
 *   GET  /api/login-options   - List available login methods
 *   POST /api/sysinfo         - Report device system info
 *   POST /api/heartbeat       - Periodic heartbeat with metrics
 *   GET  /api/peers           - List peers with sysinfo + status
 *   GET  /api/server-key      - Get RS public key (Ed25519 base64)
 * 
 * Protocol Reference — Phase 2 (Audit):
 *   POST /api/audit/conn      - Report connection event
 *   POST /api/audit/file      - Report file transfer event
 *   POST /api/audit/alarm     - Report security alarm
 *   GET  /api/audit/conn      - Query connection events
 *   GET  /api/audit/file      - Query file transfer events
 *   GET  /api/audit/alarm     - Query alarm events
 * 
 * Protocol Reference — Phase 3 (Groups & Strategies):
 *   GET/POST   /api/user-groups     - User group management
 *   GET/POST   /api/device-group    - Device group management
 *   GET        /api/device-group/accessible - Accessible device groups
 *   GET        /api/strategies      - Access control strategies
 * 
 * @author UNITRONIX
 * @version 2.0.0
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const crypto = require('crypto');
const authService = require('../services/authService');
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const betterdeskApi = require('../services/betterdeskApi');
const addressBookSync = require('../services/rustdeskAddressBookSync');
const deviceGroupService = require('../services/deviceGroupService');
const config = require('../config/config');
const { roleHasPermission } = require('../middleware/auth');

// After the API-port consolidation the RustDesk clients report audit events to
// the Go server (port 21121). When Node's own client API listener is disabled
// the Go server is the source of truth, so panel audit widgets must read audit
// data back from Go to stay consistent (notably on SQLite, where Go and Node
// keep separate database files).
const AUDIT_SOURCE_IS_GO = config.serverBackend === 'betterdesk' && !config.apiEnabled;

// ==================== Constants ====================

/** Valid connection types for audit events */
const CONN_TYPES = [0, 1, 2, 3, 4]; // Remote, FileTransfer, PortForward, Camera, Terminal

/** Valid alarm types */
const ALARM_TYPES = [0, 1, 2, 3, 4, 5, 6]; // AccessAttempt, BruteForce, IPViolation, Unauthorized, PortScan, MaliciousFile, Custom

/** Maximum lengths for string fields (input sanitization) */
const MAX_ID_LEN = 32;
const MAX_HOSTNAME_LEN = 256;
const MAX_STRING_LEN = 512;
const MAX_PATH_LEN = 1024;

// Throttle sysinfo request logging: only log once per device per 5 minutes
const _sysinfoLogTimes = new Map();
function shouldLogSysinfoRequest(deviceId) {
    const now = Date.now();
    const last = _sysinfoLogTimes.get(deviceId) || 0;
    if (now - last > 5 * 60 * 1000) {
        _sysinfoLogTimes.set(deviceId, now);
        // Prune old entries to prevent memory leak
        if (_sysinfoLogTimes.size > 1000) {
            for (const [k, v] of _sysinfoLogTimes) {
                if (now - v > 10 * 60 * 1000) _sysinfoLogTimes.delete(k);
            }
        }
        return true;
    }
    return false;
}

// ==================== Helper Functions ====================

/**
 * Extract client IP from request (uses Express trust proxy)
 */
function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
        return null;
    }
    return auth.substring(7).trim();
}

/**
 * Build a RustDesk-compatible user payload
 */
const ADMIN_ROLES = ['admin', 'super_admin', 'server_admin', 'global_admin'];
function buildUserPayload(user) {
    return {
        name: user.username,
        email: '',
        note: '',
        status: 1, // kNormal
        grp: '',
        is_admin: ADMIN_ROLES.includes(user.role)
    };
}

/**
 * Authenticate request via Bearer token — returns user or null
 */
async function authenticateRequest(req) {
    const token = extractBearerToken(req);
    if (!token) return null;
    return authService.validateAccessToken(token);
}

/**
 * Middleware: require Bearer auth
 */
async function requireAuth(req, res, next) {
    const user = await authenticateRequest(req);
    if (!user) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    req.authUser = user;
    next();
}

/**
 * Middleware: require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.authUser || !ADMIN_ROLES.includes(req.authUser.role)) {
        return res.status(403).json({ error: 'Admin privileges required' });
    }
    next();
}

/**
 * Sanitize string input — truncate and strip control chars
 */
function sanitizeStr(val, maxLen = MAX_STRING_LEN) {
    if (typeof val !== 'string') return '';
    // Strip control characters except newline/tab
    return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').substring(0, maxLen);
}

/**
 * Validate device ID format (alphanumeric, max length)
 */
function isValidDeviceId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN && /^[a-zA-Z0-9_-]+$/.test(id);
}

function canSyncDeviceInventory(user) {
    return user && user.role !== 'pro' && roleHasPermission(user.role, 'device.edit');
}

function canBrowseDeviceInventory(user) {
    return user && user.role !== 'pro' && roleHasPermission(user.role, 'device.view');
}

function canSyncDeviceTags(user) {
    return user && user.role !== 'pro' && roleHasPermission(user.role, 'device.edit');
}

function isReachableRustDeskDevice(device) {
    if (!device || device.banned || device.disabled) return false;
    if (device.online === true || device.live_online === true || device.cdap_connected === true) return true;

    const liveStatus = String(device.live_status || device.status_tier || device.status || '').trim().toLowerCase();
    return liveStatus === 'online' || liveStatus === 'degraded' || liveStatus === 'critical';
}

function getDeviceFolderId(device) {
    const raw = device && device.folder_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function folderGroupGuid(folderId) {
    return `folder_${folderId}`;
}

function folderIdFromGroupGuid(value) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(value).trim();
    const match = raw.match(/^folder_(\d+)$/i) || raw.match(/^(\d+)$/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function groupFieldValue(value) {
    if (Array.isArray(value)) return groupFieldValue(value[0]);
    if (value && typeof value === 'object') {
        return groupFieldValue(
            value.guid ||
            value.id ||
            value.device_group_guid ||
            value.device_group_id ||
            value.group_guid ||
            value.group_id ||
            value.name ||
            value.group_name ||
            value.tag ||
            value.tag_filter ||
            ''
        );
    }
    return String(value || '').trim();
}

function requestFilterParams(req) {
    const params = {};
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        Object.assign(params, req.body);
    }
    Object.assign(params, req.query || {});
    return params;
}

function requestedGroupValue(query = {}) {
    const keys = [
        'folder_id', 'folderId', 'folder', 'folder_name', 'folderName',
        'device_group_guid', 'deviceGroupGuid',
        'device_group_id', 'deviceGroupId',
        'device_group', 'deviceGroup',
        'device_group_name', 'deviceGroupName',
        'group_guid', 'groupGuid',
        'group_id', 'groupId',
        'group_name', 'groupName',
        'group'
    ];

    for (const key of keys) {
        const value = groupFieldValue(query[key]);
        if (value) return value;
    }
    return '';
}

function queryListValue(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(raw
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .map(item => sanitizeStr(item, 50))
        .filter(Boolean)
    ));
}

function requestedTagValues(query = {}) {
    return queryListValue(query.tag || query.tags || query.tag_name || query.tagName || query.tag_filter || query.tagFilter || '');
}

function deviceHasAllTags(device, expectedTags) {
    if (!expectedTags || expectedTags.length === 0) return true;
    const tags = new Set(addressBookSync.normalizeTags(device && device.tags).map(tag => tag.toLowerCase()));
    return expectedTags.every(tag => tags.has(String(tag || '').toLowerCase()));
}

function resolveRequestedFolderId(query = {}, folders = []) {
    const rawValue = requestedGroupValue(query);
    const parsed = folderIdFromGroupGuid(rawValue);
    if (parsed !== null) return parsed;

    const normalized = String(rawValue || '').trim().toLowerCase();
    if (!normalized) return null;
    const folder = (folders || []).find(item => String(item.name || '').trim().toLowerCase() === normalized);
    if (!folder) return null;
    const id = Number.parseInt(folder.id, 10);
    return Number.isFinite(id) ? id : null;
}

async function getAddressBookPeerIds(user) {
    const allowedIds = new Set();
    if (!user || !user.id) return allowedIds;

    for (const abType of ['legacy', 'personal']) {
        try {
            const row = await db.getAddressBook(user.id, abType);
            const parsed = addressBookSync.parseAddressBookData(row && row.data);
            for (const peer of parsed.peers) {
                const id = String(peer && peer.id || '').trim();
                if (id) allowedIds.add(id);
            }
        } catch (err) {
            console.warn(`[API:AB] Failed to read ${abType} address book for user ${user.username}:`, err.message);
        }
    }

    return allowedIds;
}

async function filterDevicesForRustDeskUser(user, devices) {
    let scoped = devices;
    try {
        scoped = deviceGroupService.filterDevicesByScope(
            devices,
            await deviceGroupService.getDeviceScopeForUser(db, user, devices)
        );
    } catch (err) {
        console.warn(`[API:PEERS] Failed to apply device group scope for ${user && user.username}:`, err.message);
    }

    if (canBrowseDeviceInventory(user)) return scoped;

    const allowedIds = await getAddressBookPeerIds(user);
    if (allowedIds.size === 0) return [];

    return scoped.filter(device => allowedIds.has(String(device.id)));
}

async function syncAddressBookTagsToConsole(user, dataStr, abType) {
    if (!canSyncDeviceTags(user)) return;

    const updates = addressBookSync.collectPeerTagUpdates(dataStr);
    if (updates.length === 0) return;

    let synced = 0;
    for (const update of updates) {
        if (!isValidDeviceId(update.id)) continue;
        try {
            const result = await serverBackend.setPeerTags(update.id, update.tags);
            if (result && result.success !== false) synced++;
        } catch (err) {
            console.warn(`[API:AB] Failed to sync tags for peer ${update.id}:`, err.message);
        }
    }

    if (synced > 0) {
        console.log(`[API:AB] Synced ${synced} peer tag set(s) from ${abType} address book for user ${user.username}`);
    }
}

async function getConsoleDeviceContext(user) {
    const context = {
        devices: [],
        folders: [],
        assignments: {}
    };

    try {
        context.folders = await db.getAllFolders();
    } catch (err) {
        console.warn('[API:AB] Failed to read panel folders:', err.message);
    }

    try {
        context.assignments = await db.getAllFolderAssignments();
    } catch (err) {
        console.warn('[API:AB] Failed to read folder assignments:', err.message);
    }

    try {
        context.devices = await serverBackend.getAllDevices({});
        if (!canBrowseDeviceInventory(user)) {
            context.devices = await filterDevicesForRustDeskUser(user, context.devices);
        }
    } catch (err) {
        console.warn('[API:AB] Failed to read panel devices:', err.message);
    }

    return context;
}

async function buildSyncedAddressBook(user, abType) {
    const abRecord = await db.getAddressBook(user.id, abType);
    const abData = (abRecord && abRecord.data) ? String(abRecord.data) : '{}';
    if (user.role === 'pro') {
        return abData;
    }
    const context = await getConsoleDeviceContext(user);

    // Issue #138 (2.1): Do NOT auto-include all server devices into the AB.
    // Previously this was true for admin/operator users, causing "ghost" entries
    // that reappear after deletion. The "Available Devices" tab shows all server
    // devices via /api/peers/list — the AB should only contain user-added entries.
    return addressBookSync.mergeAddressBookData(abData, {
        ...context,
        includeDevices: false
    });
}

async function getSyncedAddressBookTags(user) {
    if (user.role === 'pro') {
        try {
            const tags = await db.getAddressBookTags(user.id);
            return tags
                .map(tag => String(tag || '').trim())
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b));
        } catch (_) {
            return [];
        }
    }
    const context = await getConsoleDeviceContext(user);
    const tags = addressBookSync.collectVisibleTags(context.devices, context.folders, context.assignments);
    const seen = new Set(tags.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));

    try {
        for (const tag of await db.getAddressBookTags(user.id)) {
            const value = String(tag || '').trim();
            const normalized = value.toLowerCase();
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                tags.push(value);
            }
        }
    } catch (_) { /* non-critical */ }

    return tags.sort((a, b) => a.localeCompare(b));
}

async function getRustDeskDeviceGroups(user) {
    const groups = [];
    let devices = [];
    const accessUser = await deviceGroupService.getUserAccessContext(db, user);

    try {
        devices = await serverBackend.getAllDevices();
        devices = await filterDevicesForRustDeskUser(user, devices);
    } catch (err) {
        console.warn('[API:DEVICE-GROUP] Failed to read devices for dynamic counts:', err.message);
    }

    // Build folder assignments map for peer lookups
    let assignments = {};
    try {
        assignments = await db.getAllFolderAssignments() || {};
    } catch (_) { /* non-critical */ }

    try {
        const rawGroups = (await db.getAllDeviceGroups())
            .filter(group => folderIdFromGroupGuid(group.guid) === null)
            .filter(group => deviceGroupService.groupAllowedForUser(group, accessUser));
        const deviceGroups = await deviceGroupService.enrichGroups(db, rawGroups, devices);
        for (const group of deviceGroups) {
            const peerIds = await deviceGroupService.getGroupPeerIds(db, group, devices);
            groups.push({
                guid: group.guid,
                name: group.name,
                note: group.note || '',
                peer_ids: [...peerIds]
            });
        }
    } catch (err) {
        console.warn('[API:DEVICE-GROUP] Failed to read device groups:', err.message);
    }

    try {
        const folders = await db.getAllFolders();
        for (const folder of folders) {
            const guid = folderGroupGuid(folder.id);
            let mirrorGroup = null;
            try {
                mirrorGroup = await db.getDeviceGroupByGuid(guid);
            } catch (_) { /* non-critical */ }
            const allowedUsers = mirrorGroup && Array.isArray(mirrorGroup.allowed_users) ? mirrorGroup.allowed_users : [];
            const allowedGroups = mirrorGroup && Array.isArray(mirrorGroup.allowed_groups) ? mirrorGroup.allowed_groups : [];
            if (!deviceGroupService.groupAllowedForUser({ allowed_users: allowedUsers, allowed_groups: allowedGroups }, accessUser)) continue;

            // Collect peer IDs assigned to this folder
            const folderPeerIds = [];
            for (const [deviceId, folderId] of Object.entries(assignments)) {
                if (Number.parseInt(folderId, 10) === Number.parseInt(folder.id, 10)) {
                    folderPeerIds.push(String(deviceId));
                }
            }

            groups.push({
                guid,
                name: folder.name,
                note: '',
                peer_ids: folderPeerIds
            });
        }
    } catch (err) {
        console.warn('[API:DEVICE-GROUP] Failed to read folders:', err.message);
    }

    return groups;
}

function rustDeskDeviceGroupPayload(group, index) {
    const guid = String(group.guid || '').trim();
    // Build team.peers array from peer_ids — required by RustDesk Dart client
    const peerRefs = (group.peer_ids || []).map(id => ({ id: String(id) }));
    return {
        guid,
        name: group.name || '',
        team: { peers: peerRefs },
        access_perm: 1,
        note: group.note || '',
        created_at: '',
        sort: typeof index === 'number' ? index : 0
    };
}

async function getRustDeskPeerList(user, params = {}) {
    let folders = [];
    try {
        folders = await db.getAllFolders();
    } catch (_) { /* non-critical */ }

    const requestedFolder = resolveRequestedFolderId(params, folders);
    const requestedGroup = requestedGroupValue(params);
    const requestedTags = requestedTagValues(params);
    let devices = await serverBackend.getAllDevices({
        search: params.search || ''
    });

    let assignments = {};
    try {
        assignments = await db.getAllFolderAssignments();
        for (const device of devices) {
            const assigned = assignments[String(device.id)];
            if (assigned !== undefined) device.folder_id = assigned;
        }
    } catch (_) { /* non-critical */ }

    devices = await filterDevicesForRustDeskUser(user, devices);
    const accessUser = await deviceGroupService.getUserAccessContext(db, user);

    // Filter banned/disabled but keep offline devices visible (with correct status)
    devices = devices.filter(d => d && !d.banned && !d.disabled);

    if (requestedFolder !== null) {
        devices = devices.filter(device => getDeviceFolderId(device) === requestedFolder);
    } else if (requestedGroup) {
        const normalizedGroup = String(requestedGroup).trim().toLowerCase();
        let group = null;
        try {
            group = await db.getDeviceGroupByGuid(String(requestedGroup).trim());
            if (!group) {
                const allGroups = await db.getAllDeviceGroups();
                group = (allGroups || []).find(item => String(item.name || '').trim().toLowerCase() === normalizedGroup) || null;
            }
        } catch (_) { /* non-critical */ }
        if (group && deviceGroupService.groupAllowedForUser(group, accessUser)) {
            const groupPeerIds = await deviceGroupService.getGroupPeerIds(db, group, devices);
            devices = devices.filter(device => groupPeerIds.has(String(device.id)));
        } else if (!group && normalizedGroup) {
            devices = devices.filter(device => deviceHasAllTags(device, [normalizedGroup]));
        } else {
            devices = [];
        }
    }

    if (requestedTags.length > 0) {
        devices = devices.filter(device => deviceHasAllTags(device, requestedTags));
    }

    let folderNames = new Map();
    try {
        folderNames = new Map(folders.map(folder => [Number.parseInt(folder.id, 10), folder.name]));
    } catch (_) { /* non-critical */ }

    const manualGroupNameByPeer = new Map();
    try {
        const deviceGroups = await getRustDeskDeviceGroups(user);
        for (const group of deviceGroups) {
            if (folderIdFromGroupGuid(group.guid) !== null) continue;
            for (const id of group.peer_ids || []) {
                const key = String(id);
                if (!manualGroupNameByPeer.has(key)) {
                    manualGroupNameByPeer.set(key, group.name || '');
                }
            }
        }
    } catch (_) { /* non-critical */ }

    const allSysinfo = await db.getAllPeerSysinfo();
    const sysinfoMap = {};
    for (const sysinfo of allSysinfo) {
        sysinfoMap[sysinfo.peer_id] = sysinfo;
    }

    const enrichedPeers = devices.map(device => {
        const sysinfo = sysinfoMap[device.id] || {};
        const tags = addressBookSync.normalizeTags(device.tags);
        const folderId = getDeviceFolderId(device);
        const deviceGroupName = folderId
            ? (folderNames.get(folderId) || '')
            : (manualGroupNameByPeer.get(String(device.id)) || '');
        const hostname = sysinfo.hostname || device.hostname || '';
        const username = sysinfo.username || device.username || device.user || '';
        const platform = sysinfo.platform || device.platform || device.os || '';
        const displayName = device.display_name || '';
        const alias = displayName || device.note || hostname || String(device.id || '');
        const reachable = isReachableRustDeskDevice(device);

        // Match Go server PeerPayload format — info as nested map, status as int
        return {
            id: device.id,
            info: {
                device_name: hostname,
                os: platform,
                username: username,
                version: sysinfo.version || ''
            },
            status: 1,
            user: username,
            user_name: username,
            note: device.note || '',
            device_group_name: deviceGroupName,
            tags,
            online: reachable,
            alias,
            hash: device.hash || ''
        };
    });

    const page = Math.max(1, parseInt(params.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(params.page_size || params.pageSize, 10) || 100));
    const start = (page - 1) * pageSize;
    const paged = enrichedPeers.slice(start, start + pageSize);

    return {
        data: paged,
        total: enrichedPeers.length
    };
}

async function sendRustDeskDeviceGroups(req, res) {
    try {
        if (req.authUser && req.authUser.role === 'pro') {
            return res.json({ data: [], total: 0, msg: 'success' });
        }
        const groups = await getRustDeskDeviceGroups(req.authUser);
        return res.json({
            data: groups.map((g, i) => rustDeskDeviceGroupPayload(g, i)),
            total: groups.length,
            msg: 'success'
        });
    } catch (err) {
        console.error('[API:DEVICE-GROUP] Error:', err.message);
        return res.json({ data: [], total: 0, msg: 'success' });
    }
}

// ==================== Phase 0: Core Auth Endpoints ====================

/**
 * GET /api/login-options
 * Returns available login methods.
 * RustDesk client calls this to check for OIDC providers.
 * We only support account-password.
 */
router.get('/api/login-options', (req, res) => {
    res.json(['']);
});

/**
 * POST /api/heartbeat
 * RustDesk client sends periodic heartbeat with CPU/memory/disk metrics.
 * Stores metrics data and updates peer online status.
 * Device must exist in peer table (prevents phantom entries).
 */
router.post('/api/heartbeat', async (req, res) => {
    const body = req.body || {};

    // Extract and validate device ID
    const deviceId = sanitizeStr(body.id || body.uuid || '', MAX_ID_LEN);
    if (!deviceId || !isValidDeviceId(deviceId)) {
        return res.json({ modified_at: new Date().toISOString() });
    }

    // Verify the device exists in the peer table (prevents spoofing phantom devices)
    const existingDevice = await db.getDevice(deviceId);
    if (!existingDevice) {
        return res.json({ modified_at: new Date().toISOString() });
    }

    // Reject heartbeats from banned devices
    if (existingDevice.banned) {
        return res.json({ error: 'BANNED' });
    }

    // Parse metric data from heartbeat payload
    const cpuUsage = typeof body.cpu === 'number' ? Math.min(100, Math.max(0, body.cpu)) : 0;
    const memoryUsage = typeof body.memory === 'number' ? Math.min(100, Math.max(0, body.memory)) : 0;
    const diskUsage = typeof body.disk === 'number' ? Math.min(100, Math.max(0, body.disk)) : 0;

    try {
        await db.insertPeerMetric(deviceId, cpuUsage, memoryUsage, diskUsage);
        await db.updatePeerOnlineStatus(deviceId);
    } catch (err) {
        console.warn('[API:HEARTBEAT] Failed to store metrics:', err.message);
    }

    // Check if we need sysinfo update (missing or stale > 1 hour)
    try {
        const sysinfo = await db.getPeerSysinfo(deviceId);
        if (!sysinfo) {
            // No sysinfo - request client to send it (JSON with "sysinfo" key)
            if (shouldLogSysinfoRequest(deviceId)) {
                console.log(`[API:HEARTBEAT] Requesting sysinfo from ${deviceId} (missing)`);
            }
            return res.json({ modified_at: new Date().toISOString(), sysinfo: true });
        }

        // Check if sysinfo is older than 1 hour
        const updatedAt = new Date(sysinfo.updated_at).getTime();
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        if (updatedAt < oneHourAgo) {
            if (shouldLogSysinfoRequest(deviceId)) {
                console.log(`[API:HEARTBEAT] Requesting sysinfo refresh from ${deviceId} (stale)`);
            }
            return res.json({ modified_at: new Date().toISOString(), sysinfo: true });
        }
    } catch (err) {
        // On error, just continue with normal response
    }

    return res.json({ modified_at: new Date().toISOString() });
});

/**
 * POST /api/sysinfo
 * RustDesk client reports hardware/software info.
 * Parses and stores CPU, RAM, OS, hostname, displays, encoding, features.
 * Device must exist in peer table (prevents phantom entries).
 * 
 * IMPORTANT: Response must be plain text (not JSON):
 *   - "SYSINFO_UPDATED" → client activates PRO mode
 *   - "ID_NOT_FOUND" → client retries immediately
 *   - Anything else → client waits 120s before retry
 */
router.post('/api/sysinfo', async (req, res) => {
    const body = req.body || {};

    // Extract and validate device ID
    const deviceId = sanitizeStr(body.id || body.uuid || '', MAX_ID_LEN);
    if (!deviceId || !isValidDeviceId(deviceId)) {
        console.log('[API:SYSINFO] Invalid device ID:', deviceId);
        return res.type('text/plain').send('ID_NOT_FOUND');
    }

    // Verify the device exists in the peer table (prevents overwriting unknown devices)
    const existingDevice = await db.getDevice(deviceId);
    if (!existingDevice) {
        console.log(`[API:SYSINFO] Device not found: ${deviceId} (must register first)`);
        return res.type('text/plain').send('ID_NOT_FOUND');
    }

    // Reject sysinfo from banned devices
    if (existingDevice.banned) {
        console.log(`[API:SYSINFO] Rejected sysinfo from banned device: ${deviceId}`);
        return res.type('text/plain').send('ID_NOT_FOUND');
    }

    try {
        // RustDesk sends cpu and memory as formatted strings, parse them
        // cpu: "Intel Core i7-12700K, 5.2GHz, 24/16 cores"
        // memory: "31.87GB"
        const cpuRaw = sanitizeStr(body.cpu || '', MAX_STRING_LEN);
        const memoryRaw = sanitizeStr(body.memory || '', 64);

        // Parse CPU: extract name, frequency, cores
        let cpuName = '';
        let cpuCores = 0;
        let cpuFreqGhz = 0;
        if (cpuRaw) {
            // Parse comma-separated parts: "Intel Core i7-12700K, 5.2GHz, 24/16 cores"
            // Uses split instead of complex regex to avoid ReDoS backtracking.
            const cpuParts = cpuRaw.split(',').map(s => s.trim());
            const cpuMatch = cpuParts.length >= 1 ? [null, cpuParts[0]] : null;
            if (cpuMatch) {
                const ghzPart = cpuParts.find(p => /^\d+\.?\d*GHz$/i.test(p));
                const coresPart = cpuParts.find(p => /^\d+\/?\d*\s*cores?$/i.test(p));
                if (ghzPart) cpuMatch[2] = ghzPart.replace(/GHz$/i, '');
                if (coresPart) {
                    const cm = coresPart.match(/^(\d+)\/?(\d+)?/);
                    if (cm) { cpuMatch[3] = cm[1]; cpuMatch[4] = cm[2]; }
                }
            }
            if (cpuMatch) {
                cpuName = cpuMatch[1]?.trim() || cpuRaw;
                cpuFreqGhz = parseFloat(cpuMatch[2]) || 0;
                cpuCores = parseInt(cpuMatch[3]) || parseInt(cpuMatch[4]) || 0;
            } else {
                cpuName = cpuRaw; // Use raw if pattern doesn't match
            }
        }

        // Parse memory: "31.87GB" → 31.87
        let memoryGb = 0;
        if (memoryRaw) {
            const memMatch = memoryRaw.match(/^(\d+\.?\d*)\s*GB$/i);
            if (memMatch) {
                memoryGb = parseFloat(memMatch[1]) || 0;
            } else if (typeof body.memory === 'number') {
                memoryGb = body.memory;
            }
        }

        // Parse sysinfo fields from RustDesk client payload
        const sysinfo = {
            hostname: sanitizeStr(body.hostname || '', MAX_HOSTNAME_LEN),
            username: sanitizeStr(body.username || '', MAX_HOSTNAME_LEN),
            platform: sanitizeStr(body.platform || body.os || '', MAX_STRING_LEN),
            version: sanitizeStr(body.version || '', 64),
            cpu_name: cpuName || sanitizeStr(body.cpu_name || '', MAX_STRING_LEN),
            cpu_cores: cpuCores || (typeof body.cpu_num === 'number' ? Math.max(0, Math.min(1024, body.cpu_num)) : 0),
            cpu_freq_ghz: cpuFreqGhz || (typeof body.cpu_freq === 'number' ? Math.max(0, Math.min(100, body.cpu_freq)) : 0),
            memory_gb: memoryGb || (typeof body.memory_total === 'number' ? Math.max(0, Math.min(65536, body.memory_total)) : 0),
            os_full: sanitizeStr(body.os || body.os_full || '', MAX_STRING_LEN),
            displays: Array.isArray(body.displays) ? body.displays.slice(0, 10) : [],
            encoding: Array.isArray(body.encoding) ? body.encoding.slice(0, 20) : [],
            features: typeof body.features === 'object' && body.features !== null ? body.features : {},
            platform_additions: typeof body.platform_additions === 'object' && body.platform_additions !== null ? body.platform_additions : {}
        };

        // Limit serialized size of complex objects to prevent storage abuse (M-6)
        const maxJsonLen = 4096;
        const displaysJson = JSON.stringify(sysinfo.displays);
        const encodingJson = JSON.stringify(sysinfo.encoding);
        const featuresJson = JSON.stringify(sysinfo.features);
        if (displaysJson.length > maxJsonLen) sysinfo.displays = sysinfo.displays.slice(0, 4);
        if (encodingJson.length > maxJsonLen) sysinfo.encoding = sysinfo.encoding.slice(0, 5);
        if (featuresJson.length > maxJsonLen) sysinfo.features = {};

        await db.upsertPeerSysinfo(deviceId, sysinfo);
        console.log(`[API:SYSINFO] ✓ PRO activated for ${deviceId}: ${sysinfo.hostname} (${sysinfo.platform}) CPU: ${sysinfo.cpu_name} RAM: ${sysinfo.memory_gb}GB`);

        // Return plain text "SYSINFO_UPDATED" to activate PRO mode in client
        return res.type('text/plain').send('SYSINFO_UPDATED');
    } catch (err) {
        console.warn('[API:SYSINFO] Failed to store sysinfo:', err.message);
        // Return error but still indicate the ID was found (client won't retry immediately)
        return res.type('text/plain').send('ERROR');
    }
});

/**
 * POST /api/sysinfo_ver
 * RustDesk client checks if sysinfo needs to be re-uploaded.
 * Returns hash of current sysinfo; if client's hash matches, skip upload.
 * Empty response or any error triggers full sysinfo upload.
 */
router.post('/api/sysinfo_ver', async (req, res) => {
    const body = req.body || {};
    const deviceId = sanitizeStr(body.id || body.uuid || '', MAX_ID_LEN);

    if (!deviceId || !isValidDeviceId(deviceId)) {
        return res.type('text/plain').send('');
    }

    try {
        const sysinfo = await db.getPeerSysinfo(deviceId);
        if (sysinfo && sysinfo.raw_json) {
            // Generate hash of stored sysinfo for comparison (SHA256 truncated)
            const hash = require('crypto').createHash('sha256')
                .update(JSON.stringify(sysinfo.raw_json))
                .digest('hex')
                .substring(0, 16);
            return res.type('text/plain').send(hash);
        }
    } catch (err) {
        console.warn('[API:SYSINFO_VER] Error:', err.message);
    }

    // No sysinfo found - trigger upload
    return res.type('text/plain').send('');
});

/**
 * GET /api/ab
 * Address book — return stored address book for the authenticated user.
 * RustDesk expects: { data: "<json-string-with-tags-and-peers>", licensed_devices: 0 }
 */
router.get('/api/ab', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    try {
        const abData = await buildSyncedAddressBook(user, 'legacy');
        return res.json({ data: abData, licensed_devices: 0 });
    } catch (err) {
        console.error('[API:AB] Error reading legacy address book:', err.message);
        return res.json({ data: '{}', licensed_devices: 0 });
    }
});

/**
 * POST /api/ab
 * Address book update — save the address book data from the client.
 * RustDesk sends: { data: "<json-string>" }
 */
router.post('/api/ab', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const { data } = req.body || {};
    if (data !== undefined) {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
        try {
            await db.saveAddressBook(user.id, dataStr, 'legacy');
            await syncAddressBookTagsToConsole(user, dataStr, 'legacy');
            console.log(`[API:AB] Saved legacy address book for user ${user.username} (${dataStr.length} bytes)`);
        } catch (err) {
            console.error('[API:AB] Error saving legacy address book:', err.message);
        }
    }
    return res.json({});
});

/**
 * GET /api/ab/personal
 * Personal address book — return stored personal AB.
 */
router.get('/api/ab/personal', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    try {
        const abData = await buildSyncedAddressBook(user, 'personal');
        return res.json({ data: abData });
    } catch (err) {
        console.error('[API:AB] Error reading personal address book:', err.message);
        return res.json({ data: '{}' });
    }
});

/**
 * GET /api/audit
 * Audit log — returns combined audit summary from all audit sources.
 */
router.get('/api/audit', async (req, res) => {
    const user = await authenticateRequest(req);
    if (!user) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    // Return combined recent audit events
    try {
        if (AUDIT_SOURCE_IS_GO) {
            const [c, f, a] = await Promise.all([
                betterdeskApi.getClientAuditConnections({ limit: 50 }),
                betterdeskApi.getClientAuditFiles({ limit: 50 }),
                betterdeskApi.getClientAuditAlarms({ limit: 50 })
            ]);
            if (c || f || a) {
                return res.json({
                    data: {
                        connections: (c && c.data) || [],
                        files: (f && f.data) || [],
                        alarms: (a && a.data) || []
                    }
                });
            }
        }
        const conns = await db.getAuditConnections({ limit: 50 });
        const files = await db.getAuditFiles({ limit: 50 });
        const alarms = await db.getAuditAlarms({ limit: 50 });
        return res.json({
            data: {
                connections: conns,
                files: files,
                alarms: alarms
            }
        });
    } catch (err) {
        console.error('[API:AUDIT] Error:', err.message);
        return res.json({ data: { connections: [], files: [], alarms: [] } });
    }
});

/**
 * POST /api/ab/personal
 * Personal address book update — save personal AB data.
 */
router.post('/api/ab/personal', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const { data } = req.body || {};
    const hasData = data !== undefined && data !== null && data !== '';
    // RustDesk 1.4.7 probes with an empty POST body; legacy servers return 404.
    if (!hasData) {
        return res.status(404).end();
    }
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    try {
        await db.saveAddressBook(user.id, dataStr, 'personal');
        await syncAddressBookTagsToConsole(user, dataStr, 'personal');
        console.log(`[API:AB] Saved personal address book for user ${user.username} (${dataStr.length} bytes)`);
    } catch (err) {
        console.error('[API:AB] Error saving personal address book:', err.message);
    }
    return res.json({});
});

/**
 * GET /api/ab/tags
 * Address book tags — return tags from legacy address book.
 */
router.get('/api/ab/tags', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    try {
        const tags = await getSyncedAddressBookTags(user);
        return res.json({ data: tags });
    } catch (err) {
        console.error('[API:AB] Error reading address book tags:', err.message);
        return res.json({ data: [] });
    }
});

/**
 * GET /api/users
 * List users — return current user only (for RustDesk client with Bearer token).
 * Falls through to panel routes if no Bearer token but session exists.
 */
router.get('/api/users', async (req, res, next) => {
    const token = extractBearerToken(req);
    // If no Bearer token, fallthrough to panel routes (may have session cookie)
    if (!token) {
        return next('route');
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (user.role === 'pro') {
        return res.json({ data: [], total: 0 });
    }
    return res.json({
        data: [{
            name: user.username,
            email: '',
            note: '',
            status: 1,
            is_admin: user.role === 'admin',
            group_name: 'Default'
        }],
        total: 1
    });
});

/**
 * GET /api/peers
 * List peers/devices with sysinfo, metrics, and online status.
 * Returns RustDesk-compatible peer data merged with sysinfo.
 * Falls through to panel routes if no Bearer token but session exists.
 */
router.get('/api/peers', async (req, res, next) => {
    const token = extractBearerToken(req);
    // If no Bearer token, fallthrough to panel routes (may have session cookie)
    if (!token) {
        return next('route');
    }
    const user = await authService.validateAccessToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Pro users are API-only accounts for RustDesk PRO activation/telemetry.
    // They intentionally do not receive reachable device inventory.
    if (user.role === 'pro') {
        return res.json({ data: [], total: 0 });
    }

    try {
        const result = await getRustDeskPeerList(user, requestFilterParams(req));
        return res.json(result);
    } catch (err) {
        console.error('[API:PEERS] Error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

/**
 * GET/POST /api/peers/list
 * RustDesk PRO-compatible peer-list envelope used by some desktop builds when
 * a folder/group is selected in Available Devices.
 */
router.all('/api/peers/list', requireAuth, async (req, res) => {
    if (req.authUser && req.authUser.role === 'pro') {
        return res.json({ data: [], total: 0, msg: 'success' });
    }
    try {
        const result = await getRustDeskPeerList(req.authUser, requestFilterParams(req));
        return res.json({
            data: result.data,
            total: result.total,
            msg: 'success'
        });
    } catch (err) {
        console.error('[API:PEERS/LIST] Error:', err.message);
        return res.json({ data: [], total: 0, msg: 'success' });
    }
});

/**
 * GET /api/device-group/accessible
 * Returns accessible device groups for the current user.
 */
router.get('/api/device-group/accessible', requireAuth, async (req, res) => {
    return sendRustDeskDeviceGroups(req, res);
});

router.get('/api/group', requireAuth, sendRustDeskDeviceGroups);
router.get('/api/group/get', requireAuth, sendRustDeskDeviceGroups);
router.post('/api/group/get', requireAuth, sendRustDeskDeviceGroups);

/**
 * GET /api/device-group
 * List all device groups.
 */
router.get('/api/device-group', requireAuth, async (req, res) => {
    return sendRustDeskDeviceGroups(req, res);
});

/**
 * POST /api/device-group
 * Create or update a device group (admin only).
 */
router.post('/api/device-group', requireAuth, requireAdmin, async (req, res) => {
    try {
        const payload = deviceGroupService.normalizeGroupPayload(req.body || {});
        if (!payload.name) {
            return res.status(400).json({ error: 'Group name is required' });
        }
        if (payload.source_type === 'tag' && !payload.tag_filter) {
            return res.status(400).json({ error: 'Tag filter is required for dynamic groups' });
        }

        if (payload.guid) {
            // Update existing
            const updated = await db.updateDeviceGroup(payload.guid, {
                name: sanitizeStr(payload.name, MAX_HOSTNAME_LEN),
                note: sanitizeStr(payload.note || '', MAX_STRING_LEN),
                team_id: sanitizeStr(payload.team_id || '', 64),
                source_type: payload.source_type,
                tag_filter: payload.tag_filter
            });
            if (!updated) {
                return res.status(404).json({ error: 'Group not found' });
            }
            return res.json(updated);
        } else {
            // Create new
            const created = await db.createDeviceGroup({
                name: sanitizeStr(payload.name, MAX_HOSTNAME_LEN),
                note: sanitizeStr(payload.note || '', MAX_STRING_LEN),
                team_id: sanitizeStr(payload.team_id || '', 64),
                source_type: payload.source_type,
                tag_filter: payload.tag_filter
            });
            return res.json(created);
        }
    } catch (err) {
        console.error('[API:DEVICE-GROUP] Create/update error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/user/group
 * Get current user group info.
 */
router.get('/api/user/group', requireAuth, async (req, res) => {
    try {
        const groups = typeof db.getUserGroupsForUser === 'function'
            ? await db.getUserGroupsForUser(req.authUser.id)
            : await db.getAllUserGroups();
        if (!groups || groups.length === 0) {
            return res.json({ data: { name: 'Default', guid: 'default' } });
        }
        return res.json({
            data: {
                name: groups[0].name,
                guid: groups[0].guid,
                groups: groups.map(group => ({
                    name: group.name,
                    guid: group.guid,
                    note: group.note || '',
                    team_id: group.team_id || ''
                }))
            }
        });
    } catch (err) {
        return res.json({ data: { name: 'Default', guid: 'default' } });
    }
});

/**
 * GET /api/software/client-download-link
 * Client download link — return empty.
 */
router.get('/api/software/client-download-link', (req, res) => {
    return res.json({});
});

/**
 * GET /api/software
 * Software update check — return empty.
 */
router.get('/api/software', (req, res) => {
    return res.json({});
});

/**
 * POST /api/login
 * RustDesk-compatible login endpoint.
 * 
 * Request body (initial login):
 *   { username, password, id, uuid, autoLogin, type: "account" }
 * 
 * Request body (2FA verification):
 *   { username, tfaCode, secret, id, uuid, type: "email_code" }
 * 
 * Response types:
 *   { type: "access_token", access_token, user } — success
 *   { type: "email_check", tfa_type: "tfa_check", secret } — 2FA required (RustDesk 1.4.7+)
 */
router.post('/api/login', async (req, res) => {
    const ip = getClientIp(req);

    try {
        const body = req.body || {};

        // Debug: log exact body for Issue #104 investigation
        console.log('[API:LOGIN] Request from', ip, '- body:', JSON.stringify({
            username: body.username,
            password: body.password ? '[REDACTED]' : body.password,
            id: body.id,
            type: body.type,
            hasDeviceInfo: !!body.deviceInfo
        }));

        // Extract and sanitize credentials — trim whitespace that could cause empty username issues
        const rawUsername = body.username;
        const rawPassword = body.password;
        const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
        const password = typeof rawPassword === 'string' ? rawPassword : '';

        const { redactUsernameForLog } = require('../lib/logRedact');
        console.log(`[API:LOGIN] Login attempt from ${ip} user=${redactUsernameForLog(username)}`);

        const {
            id: clientId,
            uuid: clientUuid,
            type: reqType,
            tfaCode,
            verificationCode,
            secret: tfaSecret,
            deviceInfo
        } = body;

        // Support both field names: tfaCode (our API) and verificationCode (RustDesk client)
        const totpCode = tfaCode || verificationCode;

        // ── TFA verification step ──
        if (totpCode && tfaSecret) {
            return handleTfaVerification(req, res, ip, totpCode);
        }

        // ── Initial login step ──
        if (!username || !password) {
            console.log(`[API:LOGIN] Missing credentials - username empty: ${!username}, password empty: ${!password}, IP: ${ip}`);
            return res.status(400).json({ error: 'Missing credentials' });
        }

        // Check brute-force protection (await — checkBruteForce is async)
        const bruteCheck = await authService.checkBruteForce(username, ip);
        if (bruteCheck.blocked) {
            await db.logAction(null, 'api_login_blocked', `User: ${username}, IP: ${ip}, Reason: ${bruteCheck.reason}`, ip);
            return res.status(429).json({
                error: bruteCheck.reason,
                retry_after: bruteCheck.retryAfter
            });
        }

        // Check if the connecting device is banned (clientId = device ID)
        const sanitizedClientId = sanitizeStr(clientId || '', MAX_ID_LEN);
        if (sanitizedClientId && isValidDeviceId(sanitizedClientId)) {
            const device = await db.getDevice(sanitizedClientId);
            if (device && device.banned) {
                console.log(`[API:LOGIN] Rejected login from banned device: ${sanitizedClientId}`);
                await db.logAction(null, 'api_login_banned_device', `Device: ${sanitizedClientId}, User: ${username}`, ip);
                return res.status(403).json({ error: 'Device is banned' });
            }
        }

        // Authenticate
        const user = await authService.authenticate(username, password);

        if (authService.isAuthFailure(user) && user.__authFailure === 'username_collision') {
            authService.recordAttempt(username, ip, false);
            await db.logAction(null, 'api_login_failed', `Username collision: ${username}`, ip);
            return res.status(409).json({ error: 'Username collision: a local account with this name already exists', code: 'username_collision' });
        }

        if (!user) {
            authService.recordAttempt(username, ip, false);
            await db.logAction(null, 'api_login_failed', `User: ${username}`, ip);

            // Generic error — don't reveal whether user exists
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if TOTP 2FA is required
        if (user.totpRequired) {
            // Issue #104: stock RustDesk OSS clients (v1.4.6 and earlier) do
            // not implement the `tfa_check` response shape and reject it as
            // "bad response from server". When the operator has explicitly
            // opted in via RUSTDESK_API_DISABLE_TOTP=true, skip 2FA on this
            // (RustDesk-only) endpoint and issue an access token directly.
            // The web panel routes still enforce TOTP independently.
            //
            // SECURITY (audit fix H-04, 2026-04-10): the bypass also requires
            // RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED=true to confirm the
            // operator understands the WAN-facing risk on :21121. Without the
            // ACK flag TOTP is enforced normally even if DISABLE_TOTP is set.
            if (config.rustdeskApiDisableTotp && config.rustdeskApiDisableTotpAck) {
                authService.recordAttempt(username, ip, true);
                const token = await authService.generateAccessToken(user.id, clientId, clientUuid, ip);
                await db.updateLastLogin(user.id);
                await db.logAction(
                    user.id,
                    'api_login_success_totp_bypassed',
                    `Client: ${clientId || 'unknown'} (RUSTDESK_API_DISABLE_TOTP=true)`,
                    ip
                );
                console.warn(`[API:LOGIN] TOTP bypass active for user '${username}' (RUSTDESK_API_DISABLE_TOTP=true)`);
                return res.json({
                    type: 'access_token',
                    access_token: token,
                    user: buildUserPayload(user)
                });
            }

            // Generate a temporary secret for the TFA session
            const tfaSessionSecret = require('crypto').randomBytes(16).toString('hex');

            // Store TFA session in memory (short-lived)
            if (!req.app.locals._tfaSessions) {
                req.app.locals._tfaSessions = new Map();
            }
            req.app.locals._tfaSessions.set(tfaSessionSecret, {
                userId: user.id,
                username: user.username,
                role: user.role,
                clientId: clientId || '',
                clientUuid: clientUuid || '',
                ip,
                createdAt: Date.now()
            });

            // Cleanup old TFA sessions (>5 min)
            cleanupTfaSessions(req.app.locals._tfaSessions);

            await db.logAction(user.id, 'api_login_tfa_required', `Client: ${clientId || 'unknown'}`, ip);

            return res.json({
                type: 'email_check',
                tfa_type: 'tfa_check',
                secret: tfaSessionSecret
            });
        }

        // No 2FA — issue token directly
        authService.recordAttempt(username, ip, true);
        const token = await authService.generateAccessToken(user.id, clientId, clientUuid, ip);
        await db.updateLastLogin(user.id);
        await db.logAction(user.id, 'api_login_success', `Client: ${clientId || 'unknown'}`, ip);

        return res.json({
            type: 'access_token',
            access_token: token,
            user: buildUserPayload(user)
        });

    } catch (err) {
        console.error('RustDesk API login error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Handle TFA verification (second step of login)
 */
async function handleTfaVerification(req, res, ip, totpCode) {
    try {
        const {
            verificationCode,
            tfaCode,
            secret: tfaSecret,
            id: clientId,
            uuid: clientUuid
        } = req.body;

        const code = totpCode || tfaCode || verificationCode;

        const sessions = req.app.locals._tfaSessions;
        if (!sessions || !sessions.has(tfaSecret)) {
            return res.status(401).json({ error: 'TFA session expired or invalid' });
        }

        const session = sessions.get(tfaSecret);

        // Verify TOTP code
        const verified = authService.verifyTotpCode(session.userId, code);

        if (!verified) {
            authService.recordAttempt(session.username, ip, false);
            await db.logAction(session.userId, 'api_tfa_failed', `Client: ${session.clientId || 'unknown'}`, ip);
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        // TFA passed — clean up session and issue token
        sessions.delete(tfaSecret);

        authService.recordAttempt(session.username, ip, true);
        const token = await authService.generateAccessToken(
            session.userId,
            clientId || session.clientId,
            clientUuid || session.clientUuid,
            ip
        );
        await db.updateLastLogin(session.userId);
        await db.logAction(session.userId, 'api_login_success', `Client: ${clientId || session.clientId || 'unknown'} (2FA: totp)`, ip);

        return res.json({
            type: 'access_token',
            access_token: token,
            user: buildUserPayload({
                username: session.username,
                role: session.role
            })
        });

    } catch (err) {
        console.error('RustDesk API TFA error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
}

/**
 * POST /api/logout
 * Revoke the Bearer token.
 * RustDesk client sends { id, uuid } in body.
 */
router.post('/api/logout', async (req, res) => {
    const ip = getClientIp(req);

    try {
        const token = extractBearerToken(req);
        const { id: clientId, uuid: clientUuid } = req.body || {};

        if (token) {
            // Validate token to get user info for logging
            const user = await authService.validateAccessToken(token);
            if (user) {
                await authService.revokeClientTokens(user.id, clientId, clientUuid);
                await db.logAction(user.id, 'api_logout', `Client: ${clientId || 'unknown'}`, ip);
            }
        }

        // Always return success (don't reveal token validity)
        return res.json({});

    } catch (err) {
        console.error('RustDesk API logout error:', err);
        return res.json({});
    }
});

/**
 * GET/POST /api/currentUser
 * Returns current user info based on Bearer token.
 * RustDesk client uses POST after login, GET for refresh.
 */
router.all('/api/currentUser', async (req, res) => {
    try {
        const token = extractBearerToken(req);

        if (!token) {
            return res.status(401).json({ error: 'Authorization required' });
        }

        const user = await authService.validateAccessToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        return res.json({
            name: user.username,
            email: '',
            note: '',
            status: 1,
            is_admin: user.role === 'admin'
        });

    } catch (err) {
        console.error('RustDesk API currentUser error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ==================== Internal Helpers ====================

/**
 * Cleanup expired TFA sessions (>5 min old)
 */
function cleanupTfaSessions(sessions) {
    if (!sessions) return;
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    for (const [key, session] of sessions) {
        if (now - session.createdAt > maxAge) {
            sessions.delete(key);
        }
    }
}

// ==================== Security: Server Key Endpoint ====================

/**
 * GET /api/server-key
 * Returns the RustDesk Rendezvous Server Ed25519 public key (base64).
 * This key is used by clients to verify peer identity (signed_id_pk).
 * Public key is inherently safe to expose — no auth required.
 */
router.get('/api/server-key', (req, res) => {
    try {
        if (!fs.existsSync(config.pubKeyPath)) {
            return res.json({ key: '' });
        }
        const key = fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        // Validate: should decode to 32 bytes (Ed25519 public key)
        const decoded = Buffer.from(key, 'base64');
        if (decoded.length !== 32) {
            console.warn('[API:SERVER-KEY] Invalid RS public key length:', decoded.length);
            return res.json({ key: '' });
        }
        return res.json({ key });
    } catch (err) {
        console.warn('[API:SERVER-KEY] Error reading public key:', err.message);
        return res.json({ key: '' });
    }
});

/**
 * GET /api/server-key/fingerprint
 * Returns SHA-256 fingerprint of RS public key for out-of-band verification.
 */
router.get('/api/server-key/fingerprint', (req, res) => {
    try {
        if (!fs.existsSync(config.pubKeyPath)) {
            return res.json({ fingerprint: '', algorithm: 'SHA-256' });
        }
        const key = fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex');
        return res.json({
            fingerprint: hash.match(/.{2}/g).join(':').toUpperCase(),
            algorithm: 'SHA-256'
        });
    } catch (err) {
        return res.json({ fingerprint: '', algorithm: 'SHA-256' });
    }
});

// ==================== Phase 2: Audit Endpoints ====================

/**
 * POST /api/audit/conn
 * Report a connection event from RustDesk client.
 * Body: { host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip }
 */
router.post('/api/audit/conn', async (req, res) => {
    try {
        const body = req.body || {};

        // Validate required fields (host_id may be string or number from RustDesk client)
        const hostId = body.host_id != null ? String(body.host_id) : '';
        if (!hostId) {
            return res.status(400).json({ error: 'host_id is required' });
        }

        // Validate conn_type if provided
        const connType = typeof body.conn_type === 'number' ? body.conn_type : 0;
        if (!CONN_TYPES.includes(connType)) {
            return res.status(400).json({ error: 'Invalid conn_type' });
        }

        await db.insertAuditConnection({
            host_id: sanitizeStr(hostId, MAX_ID_LEN),
            host_uuid: sanitizeStr(body.host_uuid != null ? String(body.host_uuid) : '', MAX_ID_LEN),
            peer_id: sanitizeStr(body.peer_id != null ? String(body.peer_id) : '', MAX_ID_LEN),
            peer_name: sanitizeStr(body.peer_name || '', MAX_HOSTNAME_LEN),
            action: sanitizeStr(body.action || 'connect', 32),
            conn_type: connType,
            session_id: sanitizeStr(body.session_id || '', 64),
            ip: sanitizeStr(body.ip || getClientIp(req), 64)
        });

        return res.json({});
    } catch (err) {
        console.error('[API:AUDIT/CONN] Error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/audit/conn
 * Query connection audit events.
 * Query params: host_id, peer_id, action, limit, offset
 * Supports both Bearer token (RustDesk client) and session cookie (panel).
 */
router.get('/api/audit/conn', async (req, res) => {
    // Check Bearer token first, then session cookie
    const token = extractBearerToken(req);
    if (token) {
        const user = await authService.validateAccessToken(token);
        if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
        req.authUser = user;
    } else if (req.session && req.session.userId) {
        // Session-based panel auth — allowed
    } else {
        return res.status(401).json({ error: 'Authorization required' });
    }
    try {
        const filters = {
            host_id: req.query.host_id || '',
            peer_id: req.query.peer_id || '',
            action: req.query.action || '',
            limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100)),
            offset: Math.max(0, parseInt(req.query.offset, 10) || 0)
        };

        if (AUDIT_SOURCE_IS_GO) {
            const remote = await betterdeskApi.getClientAuditConnections(filters);
            if (remote) return res.json(remote);
        }

        const data = await db.getAuditConnections(filters);
        const total = await db.countAuditConnections(filters);

        return res.json({ data, total });
    } catch (err) {
        console.error('[API:AUDIT/CONN] Query error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

/**
 * POST /api/audit/file
 * Report a file transfer event.
 * Body: { host_id, host_uuid, peer_id, direction, path, is_file, num_files, files, ip, peer_name }
 */
router.post('/api/audit/file', async (req, res) => {
    try {
        const body = req.body || {};

        if (!body.host_id || typeof body.host_id !== 'string') {
            return res.status(400).json({ error: 'host_id is required' });
        }

        await db.insertAuditFile({
            host_id: sanitizeStr(body.host_id, MAX_ID_LEN),
            host_uuid: sanitizeStr(body.host_uuid || '', MAX_ID_LEN),
            peer_id: sanitizeStr(body.peer_id || '', MAX_ID_LEN),
            direction: [0, 1].includes(body.direction) ? body.direction : 0,
            path: sanitizeStr(body.path || '', MAX_PATH_LEN),
            is_file: body.is_file !== false,
            num_files: typeof body.num_files === 'number' ? Math.max(0, Math.min(10000, body.num_files)) : 0,
            files: Array.isArray(body.files) ? body.files.slice(0, 100).map(f => ({
                name: sanitizeStr(typeof f === 'object' && f !== null ? (f.name || '') : String(f || ''), MAX_PATH_LEN),
                size: typeof f === 'object' && f !== null && typeof f.size === 'number' ? Math.max(0, f.size) : 0
            })) : [],
            ip: sanitizeStr(body.ip || getClientIp(req), 64),
            peer_name: sanitizeStr(body.peer_name || '', MAX_HOSTNAME_LEN)
        });

        return res.json({});
    } catch (err) {
        console.error('[API:AUDIT/FILE] Error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/audit/file
 * Query file transfer audit events.
 */
router.get('/api/audit/file', requireAuth, async (req, res) => {
    try {
        const filters = {
            host_id: req.query.host_id || '',
            peer_id: req.query.peer_id || '',
            limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100)),
            offset: Math.max(0, parseInt(req.query.offset, 10) || 0)
        };

        if (AUDIT_SOURCE_IS_GO) {
            const remote = await betterdeskApi.getClientAuditFiles(filters);
            if (remote) return res.json(remote);
        }

        const data = await db.getAuditFiles(filters);
        const total = await db.countAuditFiles(filters);

        return res.json({ data, total });
    } catch (err) {
        console.error('[API:AUDIT/FILE] Query error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

/**
 * POST /api/audit/alarm
 * Report a security alarm event.
 * Body: { alarm_type, alarm_name, host_id, peer_id, ip, details }
 */
router.post('/api/audit/alarm', async (req, res) => {
    try {
        const body = req.body || {};

        const alarmType = typeof body.alarm_type === 'number' ? body.alarm_type : 0;
        if (!ALARM_TYPES.includes(alarmType)) {
            return res.status(400).json({ error: 'Invalid alarm_type (0-6)' });
        }

        await db.insertAuditAlarm({
            alarm_type: alarmType,
            alarm_name: sanitizeStr(body.alarm_name || '', MAX_STRING_LEN),
            host_id: sanitizeStr(body.host_id || '', MAX_ID_LEN),
            peer_id: sanitizeStr(body.peer_id || '', MAX_ID_LEN),
            ip: sanitizeStr(body.ip || getClientIp(req), 64),
            details: body.details || {}
        });

        return res.json({});
    } catch (err) {
        console.error('[API:AUDIT/ALARM] Error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/audit/alarm
 * Query security alarm events.
 */
router.get('/api/audit/alarm', requireAuth, async (req, res) => {
    try {
        const filters = {
            alarm_type: req.query.alarm_type !== undefined ? parseInt(req.query.alarm_type, 10) : undefined,
            host_id: req.query.host_id || '',
            limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100)),
            offset: Math.max(0, parseInt(req.query.offset, 10) || 0)
        };

        if (AUDIT_SOURCE_IS_GO) {
            const remote = await betterdeskApi.getClientAuditAlarms(filters);
            if (remote) return res.json(remote);
        }

        const data = await db.getAuditAlarms(filters);
        const total = await db.countAuditAlarms(filters);

        return res.json({ data, total });
    } catch (err) {
        console.error('[API:AUDIT/ALARM] Query error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

// ==================== Phase 3: User Groups ====================

/**
 * GET /api/user-groups
 * List all user groups.
 */
router.get('/api/user-groups', requireAuth, async (req, res) => {
    try {
        // Pro users cannot see user groups
        if (req.authUser && req.authUser.role === 'pro') {
            return res.json({ data: [], total: 0 });
        }
        const groups = await db.getAllUserGroups();
        return res.json({
            data: groups.map(g => ({
                guid: g.guid,
                name: g.name,
                note: g.note || '',
                team_id: g.team_id || ''
            })),
            total: groups.length
        });
    } catch (err) {
        console.error('[API:USER-GROUPS] Error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

/**
 * POST /api/user-groups
 * Create or update a user group (admin only).
 */
router.post('/api/user-groups', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { guid, name, note, team_id } = req.body || {};
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        if (guid) {
            const updated = await db.updateUserGroup(guid, {
                name: sanitizeStr(name, MAX_HOSTNAME_LEN),
                note: sanitizeStr(note || '', MAX_STRING_LEN),
                team_id: sanitizeStr(team_id || '', 64)
            });
            if (!updated) {
                return res.status(404).json({ error: 'Group not found' });
            }
            return res.json(updated);
        } else {
            const created = await db.createUserGroup({
                name: sanitizeStr(name, MAX_HOSTNAME_LEN),
                note: sanitizeStr(note || '', MAX_STRING_LEN),
                team_id: sanitizeStr(team_id || '', 64)
            });
            return res.json(created);
        }
    } catch (err) {
        console.error('[API:USER-GROUPS] Create/update error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ==================== Phase 3: Strategies ====================

/**
 * GET /api/strategies
 * List all access control strategies.
 */
router.get('/api/strategies', requireAuth, async (req, res) => {
    try {
        const strategies = await db.getAllStrategies();
        return res.json({
            data: strategies.map(s => ({
                guid: s.guid,
                name: s.name,
                user_group_guid: s.user_group_guid || '',
                device_group_guid: s.device_group_guid || '',
                enabled: s.enabled === 1,
                permissions: s.permissions || {}
            })),
            total: strategies.length
        });
    } catch (err) {
        console.error('[API:STRATEGIES] Error:', err.message);
        return res.json({ data: [], total: 0 });
    }
});

/**
 * POST /api/strategies
 * Create or update a strategy (admin only).
 */
router.post('/api/strategies', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { guid, name, user_group_guid, device_group_guid, enabled, permissions } = req.body || {};
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Strategy name is required' });
        }

        if (guid) {
            const updated = await db.updateStrategy(guid, {
                name: sanitizeStr(name, MAX_HOSTNAME_LEN),
                user_group_guid: sanitizeStr(user_group_guid || '', 64),
                device_group_guid: sanitizeStr(device_group_guid || '', 64),
                enabled,
                permissions: typeof permissions === 'object' ? permissions : {}
            });
            if (!updated) {
                return res.status(404).json({ error: 'Strategy not found' });
            }
            return res.json(updated);
        } else {
            const created = await db.createStrategy({
                name: sanitizeStr(name, MAX_HOSTNAME_LEN),
                user_group_guid: sanitizeStr(user_group_guid || '', 64),
                device_group_guid: sanitizeStr(device_group_guid || '', 64),
                enabled,
                permissions: typeof permissions === 'object' ? permissions : {}
            });
            return res.json(created);
        }
    } catch (err) {
        console.error('[API:STRATEGIES] Create/update error:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ==================== Security: Peer Key Endpoint ====================

/**
 * GET /api/peer-key/:id
 * Returns the Curve25519 public key for a specific peer (base64).
 * Requires authentication — keys should only be disclosed to logged-in users.
 */
router.get('/api/peer-key/:id', requireAuth, async (req, res) => {
    try {
        if (req.authUser && req.authUser.role === 'pro') {
            const peerId = sanitizeStr(req.params.id, MAX_ID_LEN);
            return res.json({ id: peerId || req.params.id, pk: '' });
        }
        const peerId = sanitizeStr(req.params.id, MAX_ID_LEN);
        if (!peerId) {
            return res.status(400).json({ error: 'Invalid peer ID' });
        }

        const device = await db.getDeviceById(peerId);
        if (!device) {
            return res.json({ id: peerId, pk: '' });
        }

        return res.json({
            id: device.id,
            pk: device.pk || ''
        });
    } catch (err) {
        console.error('[API:PEER-KEY] Error:', err.message);
        return res.json({ id: req.params.id, pk: '' });
    }
});

router.requireAuth = requireAuth;
router.sendRustDeskDeviceGroups = sendRustDeskDeviceGroups;

module.exports = router;
