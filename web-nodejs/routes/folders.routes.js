/**
 * BetterDesk Console - Folders Routes
 * Device folder organization
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const deviceGroupService = require('../services/deviceGroupService');
const { requireAuth, requirePermission } = require('../middleware/auth');

function folderGroupGuid(folderId) {
    return `folder_${folderId}`;
}

async function getFolderAllowedUsers(folderId) {
    try {
        const group = await db.getDeviceGroupByGuid(folderGroupGuid(folderId));
        return Array.isArray(group && group.allowed_users) ? group.allowed_users : [];
    } catch (_) {
        return [];
    }
}

async function ensureFolderDeviceGroup(folder) {
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
    } else {
        group = await db.createDeviceGroup(payload);
    }
    return group;
}

async function setFolderAllowedUsers(folder, allowedUsers) {
    const group = await ensureFolderDeviceGroup(folder);
    return db.setDeviceGroupUserAccess(group.guid, deviceGroupService.normalizeUsernames(allowedUsers));
}

async function getFolderAllowedGroups(folderId) {
    try {
        const group = await db.getDeviceGroupByGuid(folderGroupGuid(folderId));
        return Array.isArray(group && group.allowed_groups) ? group.allowed_groups : [];
    } catch (_) {
        return [];
    }
}

async function setFolderAllowedUserGroups(folder, allowedGroups) {
    const group = await ensureFolderDeviceGroup(folder);
    return db.setDeviceGroupUserGroupAccess(group.guid, deviceGroupService.normalizeGroupGuids(allowedGroups));
}

async function enrichFolderAccess(folder) {
    folder.allowed_users = await getFolderAllowedUsers(folder.id);
    folder.allowed_groups = await getFolderAllowedGroups(folder.id);
    return folder;
}

/**
 * GET /api/folders - Get all folders
 */
router.get('/api/folders', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const folders = await db.getAllFolders();

        // Enrich each folder with device_count from assignments table
        try {
            const assignments = await db.getAllFolderAssignments();
            const countMap = {};
            for (const [, folderIdRaw] of Object.entries(assignments)) {
                const folderId = Number(folderIdRaw);
                if (!Number.isFinite(folderId)) continue;
                countMap[folderId] = (countMap[folderId] || 0) + 1;
            }
            for (const f of folders) {
                f.device_count = countMap[Number(f.id)] || 0;
                await enrichFolderAccess(f);
            }
        } catch (err) {
            console.error('Failed to compute folder device counts:', err.message);
        }

        res.json({
            success: true,
            data: {
                folders,
                total: folders.length
            }
        });
    } catch (err) {
        console.error('Get folders error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/folders - Create new folder
 */
router.post('/api/folders', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const { name, color, icon, allowed_users, allowed_groups } = req.body;
        
        if (!name || name.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.name_required')
            });
        }
        
        if (name.length > 50) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.name_too_long')
            });
        }
        
        const result = await db.createFolder(name.trim(), color || '#6366f1', icon || 'folder');
        const folder = {
            id: result.id,
            name: name.trim(),
            color: color || '#6366f1',
            icon: icon || 'folder'
        };
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_users')) {
            await setFolderAllowedUsers(folder, allowed_users);
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_groups')) {
            await setFolderAllowedUserGroups(folder, allowed_groups);
        }
        await enrichFolderAccess(folder);
        
        // Log action
        await db.logAction(req.session.userId, 'folder_created', `Created folder: ${name}`, req.ip);
        
        res.json({
            success: true,
            data: {
                ...folder
            }
        });
    } catch (err) {
        console.error('Create folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/folders/:id - Update folder
 */
router.patch('/api/folders/:id', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const { name, color, icon, allowed_users, allowed_groups } = req.body;
        
        const folder = await db.getFolderById(folderId);
        if (!folder) {
            return res.status(404).json({
                success: false,
                error: req.t('folders.not_found')
            });
        }
        
        if (name !== undefined) {
            if (name.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: req.t('folders.name_required')
                });
            }
            if (name.length > 50) {
                return res.status(400).json({
                    success: false,
                    error: req.t('folders.name_too_long')
                });
            }
        }
        
        await db.updateFolder(folderId, {
            name: name !== undefined ? name.trim() : undefined,
            color,
            icon
        });
        const updatedFolder = {
            ...folder,
            id: folderId,
            name: name !== undefined ? name.trim() : folder.name,
            color: color !== undefined ? color : folder.color,
            icon: icon !== undefined ? icon : folder.icon
        };
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_users')) {
            await setFolderAllowedUsers(updatedFolder, allowed_users);
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_groups')) {
            await setFolderAllowedUserGroups(updatedFolder, allowed_groups);
        } else {
            await ensureFolderDeviceGroup(updatedFolder);
        }
        
        // Log action
        await db.logAction(req.session.userId, 'folder_updated', `Updated folder: ${name || folder.name}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Update folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/folders/:id - Delete folder
 */
router.delete('/api/folders/:id', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        
        const folder = await db.getFolderById(folderId);
        if (!folder) {
            return res.status(404).json({
                success: false,
                error: req.t('folders.not_found')
            });
        }
        
        // Remove folder assignment from devices
        await db.unassignDevicesFromFolder(folderId);
        
        // Delete folder
        await db.deleteFolder(folderId);
        try {
            await db.deleteDeviceGroup(folderGroupGuid(folderId));
        } catch (_) { /* non-critical */ }
        
        // Log action
        await db.logAction(req.session.userId, 'folder_deleted', `Deleted folder: ${folder.name}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Delete folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/folders/:id/devices - Assign devices to folder
 */
router.post('/api/folders/:id/devices', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const { deviceIds } = req.body;
        
        if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.no_devices_selected')
            });
        }
        
        // Verify folder exists (null = unassign)
        if (folderId !== 0) {
            const folder = await db.getFolderById(folderId);
            if (!folder) {
                return res.status(404).json({
                    success: false,
                    error: req.t('folders.not_found')
                });
            }
        }
        
        const assignFolderId = folderId === 0 ? null : folderId;
        
        await db.assignDevicesToFolder(deviceIds, assignFolderId);
        
        // Log action
        await db.logAction(req.session.userId, 'devices_moved', 
            `Moved ${deviceIds.length} device(s) to folder ID: ${folderId}`, req.ip);
        
        res.json({
            success: true,
            data: { count: deviceIds.length }
        });
    } catch (err) {
        console.error('Assign devices error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/devices/:id/folder - Assign single device to folder
 */
router.patch('/api/devices/:id/folder', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const deviceId = req.params.id;
        const { folderId } = req.body;
        
        // Use serverBackend to verify device exists (works in both modes)
        const device = await serverBackend.getDeviceById(deviceId);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        // Verify folder exists (null to unassign)
        if (folderId !== null && folderId !== undefined) {
            const folder = await db.getFolderById(folderId);
            if (!folder) {
                return res.status(404).json({
                    success: false,
                    error: req.t('folders.not_found')
                });
            }
        }
        
        await db.assignDeviceToFolder(deviceId, folderId);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Assign device folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

module.exports = router;
