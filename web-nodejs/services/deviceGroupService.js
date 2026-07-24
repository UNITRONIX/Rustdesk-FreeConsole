'use strict';

const { isSuperAdminRole } = require('../middleware/auth');
const config = require('../config/config');

let scopeDefaultCache = { value: null, at: 0 };

async function isDeviceScopeRestrictedDefault(db) {
    const envRestricted = String(config.deviceScopeDefault || 'open').toLowerCase() === 'restricted';
    if (!db || typeof db.getSetting !== 'function') return envRestricted;
    const now = Date.now();
    if (scopeDefaultCache.value !== null && now - scopeDefaultCache.at < 30000) {
        return scopeDefaultCache.value;
    }
    try {
        const stored = await db.getSetting('device_scope_default');
        const restricted = stored
            ? String(stored).toLowerCase() === 'restricted'
            : envRestricted;
        scopeDefaultCache = { value: restricted, at: now };
        return restricted;
    } catch (_) {
        return envRestricted;
    }
}

function invalidateDeviceScopeDefaultCache() {
    scopeDefaultCache = { value: null, at: 0 };
}

function normalizeTags(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).map(t => t.trim()).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.map(String).map(t => t.trim()).filter(Boolean);
        } catch (_) {}
        return value.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [];
}

function normalizeUsernames(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(raw.map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
}

function normalizeGroupGuids(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(raw.map(item => {
        if (item && typeof item === 'object') return String(item.guid || '').trim();
        return String(item || '').trim();
    }).filter(Boolean))).slice(0, 100);
}

function normalizeGroupPayload(body = {}) {
    const sourceType = body.source_type === 'tag' || body.dynamic === true ? 'tag' : 'manual';
    const tagFilter = sourceType === 'tag' ? String(body.tag_filter || body.tag || '').trim().slice(0, 50) : '';
    const payload = {
        guid: body.guid ? String(body.guid).trim().slice(0, 64) : '',
        name: String(body.name || '').trim().slice(0, 80),
        source_type: sourceType,
        tag_filter: tagFilter,
        allowed_users: normalizeUsernames(body.allowed_users),
        allowed_groups: normalizeGroupGuids(body.allowed_groups || body.allowed_user_groups || body.user_group_guids)
    };
    if (Object.prototype.hasOwnProperty.call(body, 'note')) {
        payload.note = String(body.note || '').trim().slice(0, 512);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'team_id')) {
        payload.team_id = String(body.team_id || '').trim().slice(0, 64);
    }
    return payload;
}

function buildDeviceGroupCreateFields(payload) {
    return {
        name: payload.name,
        note: Object.prototype.hasOwnProperty.call(payload, 'note') ? payload.note : '',
        team_id: Object.prototype.hasOwnProperty.call(payload, 'team_id') ? payload.team_id : '',
        source_type: payload.source_type,
        tag_filter: payload.tag_filter
    };
}

function buildDeviceGroupUpdateFields(payload) {
    const data = {
        name: payload.name,
        source_type: payload.source_type,
        tag_filter: payload.tag_filter
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'note')) {
        data.note = payload.note;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'team_id')) {
        data.team_id = payload.team_id;
    }
    return data;
}

function hasTag(device, tag) {
    const expected = String(tag || '').trim().toLowerCase();
    if (!expected) return false;
    return normalizeTags(device && device.tags).some(t => t.toLowerCase() === expected);
}

function folderIdFromGroupGuid(value) {
    const match = String(value || '').trim().match(/^folder_(\d+)$/i);
    if (!match) return null;
    const id = Number.parseInt(match[1], 10);
    return Number.isFinite(id) ? id : null;
}

function getGroupFolderId(group) {
    const explicit = group && group.folder_id;
    if (explicit !== undefined && explicit !== null && explicit !== '') {
        const id = Number.parseInt(explicit, 10);
        if (Number.isFinite(id)) return id;
    }
    return folderIdFromGroupGuid(group && group.guid);
}

function groupAllowedForUser(group, user) {
    if (!user || isSuperAdminRole(user.role) || user.role === 'global_admin' || user.role === 'server_admin') {
        return true;
    }
    const allowedUsers = normalizeUsernames(group && group.allowed_users);
    const allowedGroups = normalizeGroupGuids(group && (group.allowed_groups || group.allowed_user_groups));
    if (allowedUsers.length === 0 && allowedGroups.length === 0) return true;
    if (allowedUsers.includes(user.username)) return true;

    const userGroups = new Set(normalizeGroupGuids(user.user_groups || user.group_guids || user.allowed_groups));
    return allowedGroups.some(guid => userGroups.has(guid));
}

async function getUserAccessContext(db, user) {
    if (!user || !user.id || isSuperAdminRole(user.role) || user.role === 'global_admin' || user.role === 'server_admin') {
        return user;
    }
    if (Array.isArray(user.user_groups) || typeof db.getUserGroupsForUser !== 'function') return user;
    try {
        const groups = await db.getUserGroupsForUser(user.id);
        return {
            ...user,
            user_groups: (groups || []).map(group => group.guid).filter(Boolean)
        };
    } catch (_) {
        return user;
    }
}

async function getGroupPeerIds(db, group, devices = []) {
    const ids = new Set();
    const folderId = getGroupFolderId(group);
    if (folderId !== null) {
        for (const device of devices || []) {
            const deviceFolderId = Number.parseInt(device && device.folder_id, 10);
            if (Number.isFinite(deviceFolderId) && deviceFolderId === folderId) {
                ids.add(String(device.id));
            }
        }
        return ids;
    }

    if (group && group.guid) {
        try {
            const staticIds = await db.getDeviceGroupMembers(group.guid);
            for (const id of staticIds || []) ids.add(String(id));
        } catch (_) {}
    }

    if ((group.source_type || 'manual') === 'tag' && group.tag_filter) {
        for (const device of devices || []) {
            if (hasTag(device, group.tag_filter)) ids.add(String(device.id));
        }
    }

    return ids;
}

async function enrichGroups(db, groups, devices = []) {
    const enriched = [];
    for (const group of groups || []) {
        const memberIds = await getGroupPeerIds(db, group, devices);
        enriched.push({
            ...group,
            source_type: group.source_type || 'manual',
            tag_filter: group.tag_filter || '',
            allowed_users: Array.isArray(group.allowed_users) ? group.allowed_users : normalizeUsernames(group.allowed_users),
            allowed_groups: Array.isArray(group.allowed_groups) ? group.allowed_groups : normalizeGroupGuids(group.allowed_groups),
            allowed_user_groups: Array.isArray(group.allowed_user_groups) ? group.allowed_user_groups : [],
            member_count: memberIds.size
        });
    }
    return enriched;
}

async function getDeviceScopeForUser(db, user, devices = []) {
    if (!user || !user.id || isSuperAdminRole(user.role) || user.role === 'global_admin' || user.role === 'server_admin') {
        return null;
    }

    if (typeof db.getAllDeviceGroups !== 'function') return null;

    const restrictedDefault = await isDeviceScopeRestrictedDefault(db);
    const accessUser = await getUserAccessContext(db, user);
    const groups = await db.getAllDeviceGroups();
    const restrictedGroups = (groups || []).filter(group =>
        normalizeUsernames(group.allowed_users).length > 0 ||
        normalizeGroupGuids(group.allowed_groups || group.allowed_user_groups).length > 0
    );

    let peerGrants = [];
    if (typeof db.getUserPeerGrants === 'function') {
        try {
            peerGrants = await db.getUserPeerGrants(user.id);
        } catch (_) {
            peerGrants = [];
        }
    }

    if (restrictedGroups.length === 0 && peerGrants.length === 0) {
        return restrictedDefault ? new Set() : null;
    }

    const allowedIds = new Set();
    const restrictedIds = new Set();
    for (const group of restrictedGroups) {
        const ids = await getGroupPeerIds(db, group, devices);
        const target = groupAllowedForUser(group, accessUser) ? allowedIds : restrictedIds;
        for (const id of ids) target.add(id);
    }
    for (const id of peerGrants) allowedIds.add(String(id));

    if (restrictedDefault) {
        return allowedIds;
    }

    const visible = new Set();
    for (const device of devices || []) {
        const id = String(device && device.id || '');
        if (!id) continue;
        if (!restrictedIds.has(id) || allowedIds.has(id)) visible.add(id);
    }
    return visible;
}

function filterDevicesByScope(devices, allowedIds) {
    if (!allowedIds) return devices;
    return (devices || []).filter(device => allowedIds.has(String(device.id)));
}

async function userCanAccessDevice(db, user, device, allDevices) {
    const scope = await getDeviceScopeForUser(db, user, allDevices || (device ? [device] : []));
    if (!scope) return true;
    return device && scope.has(String(device.id));
}

async function collectAclUsernames(db, group, targetSet) {
    if (!group || !targetSet) return;
    const allowedUsers = normalizeUsernames(group.allowed_users);
    const allowedGroups = normalizeGroupGuids(group.allowed_groups || group.allowed_user_groups);
    if (allowedUsers.length === 0 && allowedGroups.length === 0) return;
    for (const username of allowedUsers) targetSet.add(username);
    for (const guid of allowedGroups) {
        if (typeof db.getUsernamesByUserGroupGuid !== 'function') continue;
        const members = await db.getUsernamesByUserGroupGuid(guid);
        for (const username of members || []) targetSet.add(username);
    }
}

async function resolveOperatorUsernamesForDevice(db, deviceId) {
    const cleanId = String(deviceId || '').trim();
    if (!cleanId) return [];

    const usernames = new Set();
    const assignments = await db.getAllFolderAssignments();
    let folderId = null;
    for (const row of assignments || []) {
        if (String(row.device_id) === cleanId) {
            folderId = row.folder_id;
            break;
        }
    }

    if (folderId != null && typeof db.getDeviceGroupByGuid === 'function') {
        const folderGroup = await db.getDeviceGroupByGuid(`folder_${folderId}`);
        await collectAclUsernames(db, folderGroup, usernames);
    }

    if (typeof db.getAllDeviceGroups === 'function') {
        const groups = await db.getAllDeviceGroups();
        let devices = [];
        if (typeof db.getAllPeers === 'function') {
            devices = await db.getAllPeers();
        }
        for (const group of groups || []) {
            const peerIds = await getGroupPeerIds(db, group, devices);
            if (!peerIds.has(cleanId)) continue;
            await collectAclUsernames(db, group, usernames);
        }
    }

    return [...usernames];
}

async function resolveOperatorEmailsForDevice(db, deviceId) {
    const usernames = await resolveOperatorUsernamesForDevice(db, deviceId);
    if (!usernames.length || typeof db.getUsersEmailsByUsernames !== 'function') return [];
    const rows = await db.getUsersEmailsByUsernames(usernames);
    const seen = new Set();
    const result = [];
    for (const row of rows || []) {
        const email = String(row.email || '').trim();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        result.push({ username: row.username, email });
    }
    return result;
}

async function resolveFolderNameForDevice(db, deviceId) {
    const cleanId = String(deviceId || '').trim();
    if (!cleanId || typeof db.getAllFolderAssignments !== 'function' || typeof db.getFolderById !== 'function') {
        return '';
    }
    const assignments = await db.getAllFolderAssignments();
    let folderId = null;
    for (const row of assignments || []) {
        if (String(row.device_id) === cleanId) {
            folderId = row.folder_id;
            break;
        }
    }
    if (folderId == null) return '';
    const folder = await db.getFolderById(folderId);
    return folder && folder.name ? String(folder.name) : '';
}

module.exports = {
    normalizeTags,
    normalizeUsernames,
    normalizeGroupGuids,
    normalizeGroupPayload,
    buildDeviceGroupCreateFields,
    buildDeviceGroupUpdateFields,
    folderIdFromGroupGuid,
    getGroupFolderId,
    groupAllowedForUser,
    getUserAccessContext,
    getGroupPeerIds,
    enrichGroups,
    getDeviceScopeForUser,
    filterDevicesByScope,
    userCanAccessDevice,
    resolveOperatorUsernamesForDevice,
    resolveOperatorEmailsForDevice,
    resolveFolderNameForDevice,
    invalidateDeviceScopeDefaultCache,
};
