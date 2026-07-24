/**
 * User device scope — folder ACL sync, peer grants, effective visibility.
 */

const config = require('../config/config');
const deviceGroupService = require('./deviceGroupService');

function folderGroupGuid(folderId) {
    return `folder_${folderId}`;
}

function normalizeFolderIds(value) {
    const raw = Array.isArray(value) ? value : [];
    return Array.from(new Set(raw.map(v => Number.parseInt(v, 10)).filter(Number.isFinite))).slice(0, 200);
}

function normalizePeerIds(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(raw.map(v => String(v || '').trim()).filter(Boolean))).slice(0, 500);
}

async function ensureFolderMirrorGroup(db, folder) {
    const guid = folderGroupGuid(folder.id);
    const payload = {
        guid,
        name: folder.name,
        note: 'BetterDesk folder access scope',
        source_type: 'manual',
        tag_filter: ''
    };
    let group = await db.getDeviceGroupByGuid(guid);
    if (group) {
        await db.updateDeviceGroup(guid, payload);
        group = await db.getDeviceGroupByGuid(guid);
    } else if (typeof db.createDeviceGroup === 'function') {
        group = await db.createDeviceGroup(payload);
    }
    return group;
}

async function getUserFolderIds(db, username) {
    if (!username || typeof db.getAllFolders !== 'function') return [];
    const folders = await db.getAllFolders();
    const result = [];
    for (const folder of folders || []) {
        const group = await db.getDeviceGroupByGuid(folderGroupGuid(folder.id));
        if (!group) continue;
        const users = deviceGroupService.normalizeUsernames(group.allowed_users);
        if (users.includes(username)) result.push(Number(folder.id));
    }
    return result;
}

async function syncUserFolderAccess(db, username, folderIds) {
    if (!username || typeof db.getAllFolders !== 'function') return [];
    const selected = new Set(normalizeFolderIds(folderIds));
    const folders = await db.getAllFolders();
    for (const folder of folders || []) {
        const group = await ensureFolderMirrorGroup(db, folder);
        if (!group) continue;
        const currentUsers = deviceGroupService.normalizeUsernames(group.allowed_users);
        const wantAccess = selected.has(Number(folder.id));
        const hasAccess = currentUsers.includes(username);
        if (wantAccess && !hasAccess) {
            await db.setDeviceGroupUserAccess(group.guid, [...currentUsers, username]);
        } else if (!wantAccess && hasAccess) {
            await db.setDeviceGroupUserAccess(
                group.guid,
                currentUsers.filter(name => name !== username)
            );
        }
    }
    return Array.from(selected);
}

async function getUserPeerGrantIds(db, userId) {
    if (!userId || typeof db.getUserPeerGrants !== 'function') return [];
    return db.getUserPeerGrants(userId);
}

async function syncUserPeerGrants(db, userId, peerIds) {
    if (!userId || typeof db.setUserPeerGrants !== 'function') return [];
    const normalized = normalizePeerIds(peerIds);
    await db.setUserPeerGrants(userId, normalized);
    return normalized;
}

async function countEffectiveScope(db, user, devices) {
    const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
    if (scope === null) return { count: (devices || []).length, restricted: false };
    return { count: scope.size, restricted: true };
}

function isDeviceScopeRestrictedDefault() {
    return String(config.deviceScopeDefault || 'open').toLowerCase() === 'restricted';
}

module.exports = {
    folderGroupGuid,
    normalizeFolderIds,
    normalizePeerIds,
    getUserFolderIds,
    syncUserFolderAccess,
    getUserPeerGrantIds,
    syncUserPeerGrants,
    countEffectiveScope,
    isDeviceScopeRestrictedDefault
};
