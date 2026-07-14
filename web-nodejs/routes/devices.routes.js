/**
 * BetterDesk Console - Devices Routes
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const betterdeskApi = require('../services/betterdeskApi');
const addressBookSync = require('../services/rustdeskAddressBookSync');
const deviceGroupService = require('../services/deviceGroupService');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { bodyInt, bodyString, bodyBool, plainBodyObject } = require('../lib/bodyScalars');

/**
 * GET /devices - Devices list page
 */
router.get('/devices', requireAuth, (req, res) => {
    res.render('devices', {
        title: req.t('nav.devices'),
        activePage: 'devices'
    });
});

/**
 * GET /api/devices - Get devices list (JSON)
 */
// Allowed values for sort parameters (prevent SQL injection via sort columns)
const ALLOWED_SORT_FIELDS = ['last_online', 'id', 'hostname', 'created_at', 'os', 'version', 'username', 'note'];
const ALLOWED_SORT_ORDERS = ['asc', 'desc'];

const GO_ID_RESERVED_DELETED_MSG =
    'This ID belongs to a deleted device. Restore or permanently delete that device before reusing the ID.';

function mapChangeIdError(req, error) {
    if (!error) return req.t('devices.change_id_failed');
    const text = String(error);
    if (text === GO_ID_RESERVED_DELETED_MSG || text.includes('deleted device')) {
        return req.t('devices.id_reserved_deleted');
    }
    if (text === 'Device ID already exists') {
        return req.t('devices.id_exists');
    }
    return error;
}

router.get('/api/devices', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        // Validate and sanitize sort parameters
        const sortBy = ALLOWED_SORT_FIELDS.includes(req.query.sortBy) 
            ? req.query.sortBy : 'last_online';
        const sortOrder = ALLOWED_SORT_ORDERS.includes(req.query.sortOrder?.toLowerCase()) 
            ? req.query.sortOrder.toLowerCase() : 'desc';
        
        const filters = {
            search: req.query.search || '',
            status: req.query.status || '',
            hasNotes: req.query.hasNotes === 'true',
            includeDeleted: req.query.includeDeleted === 'true',
            sortBy,
            sortOrder
        };
        
        let devices = await serverBackend.getAllDevices(filters);
        const scope = await deviceGroupService.getDeviceScopeForUser(db, req.session.user, devices);
        devices = deviceGroupService.filterDevicesByScope(devices, scope);
        for (const device of devices) {
            try {
                device.groups = await db.getDeviceGroupsForPeer(device.id);
            } catch (_) {
                device.groups = [];
            }
        }
        
        res.json({
            success: true,
            data: {
                devices,
                total: devices.length
            }
        });
    } catch (err) {
        console.error('Get devices error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

function normalizeActivityReportBody(body, visibleDevices) {
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const fromDate = String(payload.from_date || '').trim();
    const toDate = String(payload.to_date || '').trim();
    const timezone = String(payload.timezone || 'UTC').trim();
    if ((fromDate && !datePattern.test(fromDate)) || (toDate && !datePattern.test(toDate))) {
        const err = new Error('Dates must use YYYY-MM-DD');
        err.status = 400;
        throw err;
    }
    if (!/^[A-Za-z0-9_+./-]{1,64}$/.test(timezone)) {
        const err = new Error('Invalid timezone');
        err.status = 400;
        throw err;
    }

    const visibleById = new Map((visibleDevices || []).map(device => [String(device.id), device]));
    let selected = Array.isArray(payload.device_ids)
        ? Array.from(new Set(payload.device_ids.map(String))).filter(id => visibleById.has(id))
        : Array.from(visibleById.keys());
    if (payload.live_only === true || payload.connected_only === true) {
        selected = selected.filter(id => visibleById.get(id)?.remote_live === true);
    }
    if (selected.length > 1000) {
        const err = new Error('Too many devices selected');
        err.status = 400;
        throw err;
    }
    const operators = Array.isArray(payload.operators)
        ? Array.from(new Set(payload.operators.map(value => String(value).trim()).filter(Boolean))).slice(0, 100)
        : [];
    return {
        from_date: fromDate,
        to_date: toDate,
        timezone,
        device_ids: selected,
        live_only: payload.live_only === true || payload.connected_only === true,
        operators
    };
}

async function buildVisibleActivityReport(req, requestBody = req.body) {
    const visibleDevices = await getVisibleDevicesForRequest(req);
    const payload = normalizeActivityReportBody(requestBody, visibleDevices);
    const result = await betterdeskApi.getDeviceActivityReport({
        from_date: payload.from_date,
        to_date: payload.to_date,
        timezone: payload.timezone,
        // A non-empty sentinel keeps an empty scoped selection from being
        // interpreted by the Go API as "all server devices".
        device_ids: payload.device_ids.length > 0 ? payload.device_ids : ['__no_visible_devices__'],
        operators: payload.operators
    });
    if (!result.success) {
        const err = new Error(result.error || 'Failed to generate connected-time report');
        err.status = 502;
        throw err;
    }
    return result.data;
}

/**
 * POST /api/devices/activity/report - Connected-time report scoped to devices
 * visible to the signed-in console user.
 */
router.post('/api/devices/activity/report', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const report = await buildVisibleActivityReport(req);
        res.json({ success: true, data: report });
    } catch (err) {
        console.error('Device activity report error:', err);
        res.status(err.status || 500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * Browser remote viewer lifecycle. The signed-in console user is always the
 * operator; clients cannot submit another username.
 */
router.post('/api/devices/remote-sessions/event', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const action = String(payload.action || '').trim().toLowerCase();
        const sessionId = String(payload.session_id || '').trim();
        const deviceId = String(payload.device_id || '').trim();
        const reason = String(payload.reason || '').trim().slice(0, 64);
        const connectionType = Number.isInteger(payload.connection_type) ? payload.connection_type : 0;
        if (!['start', 'heartbeat', 'end'].includes(action) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
            ![0, 1, 2, 3, 4].includes(connectionType)) {
            return res.status(400).json({ success: false, error: 'Invalid remote-session event' });
        }
        if (action === 'start') {
            const visibleDevices = await getVisibleDevicesForRequest(req);
            if (!deviceId || !visibleDevices.some(device => String(device.id) === deviceId)) {
                return res.status(403).json({ success: false, error: 'Device is not visible to this user' });
            }
        }
        const operator = String(req.session.user?.username || req.session.user?.name || '').trim();
        if (!operator) return res.status(401).json({ success: false, error: 'Authenticated operator is required' });
        const result = await betterdeskApi.recordRemoteSessionEvent({
            action,
            session_id: sessionId,
            device_id: deviceId,
            operator_username: operator,
            connection_type: connectionType,
            reason
        });
        if (!result.success) {
            return res.status(502).json({ success: false, error: result.error || 'Failed to record remote session' });
        }
        res.json({ success: true, data: result.data });
    } catch (err) {
        console.error('Remote session event error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

function csvCell(value) {
    let text = String(value ?? '');
    // Prevent spreadsheet applications from treating device-supplied values
    // (hostname, display name, user) as formulas when the CSV is opened.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function csvDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function sendDeviceActivityCSV(req, res, requestBody) {
    try {
        const report = await buildVisibleActivityReport(req, requestBody);
        const rows = [[
            'User', 'Controller Remote PC ID', 'Controller name', 'Target Remote PC ID',
            'Target display name', 'Target hostname', 'Started at', 'Ended at',
            'Live', 'Connection type', 'Source', 'Duration in report range', 'Duration seconds in report range',
            'Full session duration', 'Full session duration seconds',
            'Report from', 'Report to', 'Timezone'
        ]];
        for (const device of report.devices || []) {
            for (const session of (device.intervals || [])) {
                rows.push([
                    session.operator || '',
                    session.controller_id || '',
                    session.controller_name || '',
                    device.peer_id,
                    device.display_name || device.hostname || device.peer_id,
                    device.hostname || '',
                    session.started_at || '',
                    session.ended_at || '',
                    session.ongoing ? 'yes' : 'no',
                    session.connection_type ?? 0,
                    session.source || '',
                    csvDuration(session.connected_seconds),
                    session.connected_seconds || 0,
                    csvDuration(session.actual_connected_seconds ?? session.connected_seconds),
                    session.actual_connected_seconds ?? session.connected_seconds ?? 0,
                    report.from_date,
                    report.to_date,
                    report.timezone
                ]);
            }
        }
        const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
        const filename = `remote-live-sessions_${report.from_date}_${report.to_date}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(csv);
        try {
            await db.logAction(req.session.userId, 'device_activity_exported',
                `Remote-session CSV exported (${report.from_date}..${report.to_date}, ${report.totals?.sessions || 0} sessions)`, req.ip);
        } catch (_) {}
    } catch (err) {
        console.error('Device activity CSV export error:', err);
        res.status(err.status || 500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
}

/** POST /api/devices/activity/export - legacy JSON export request. */
router.post('/api/devices/activity/export', requireAuth, requirePermission('device.view'), async (req, res) => {
    await sendDeviceActivityCSV(req, res, req.body);
});

/** GET /api/devices/activity/export - direct browser download, not a Blob. */
router.get('/api/devices/activity/export', requireAuth, requirePermission('device.view'), async (req, res) => {
    const operatorQuery = req.query.operator;
    await sendDeviceActivityCSV(req, res, {
        from_date: req.query.from_date,
        to_date: req.query.to_date,
        timezone: req.query.timezone,
        live_only: req.query.live_only === 'true',
        operators: Array.isArray(operatorQuery) ? operatorQuery : (operatorQuery ? [operatorQuery] : [])
    });
});

/**
 * GET /api/tags - Get all visible device tags.
 */
router.get('/api/tags', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const devices = await getVisibleDevicesForRequest(req);
        res.json({
            success: true,
            data: {
                tags: addressBookSync.collectVisibleTags(devices, [], {})
            }
        });
    } catch (err) {
        console.error('Get tags error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

function isValidGroupGuid(guid) {
    return typeof guid === 'string' && guid.length > 0 && guid.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(guid);
}

function areValidGroupGuids(guids) {
    return Array.isArray(guids) && guids.length <= 100 && guids.every(isValidGroupGuid);
}

async function getVisibleDevicesForRequest(req) {
    const devices = await serverBackend.getAllDevices({});
    const scope = await deviceGroupService.getDeviceScopeForUser(db, req.session.user, devices);
    return deviceGroupService.filterDevicesByScope(devices, scope);
}

async function getVisibleDeviceGroupsForRequest(req) {
    let groups = (await db.getAllDeviceGroups())
        .filter(group => deviceGroupService.folderIdFromGroupGuid(group.guid) === null);
    const accessUser = await deviceGroupService.getUserAccessContext(db, req.session.user);
    groups = groups.filter(group => deviceGroupService.groupAllowedForUser(group, accessUser));
    return groups;
}

async function rejectIfDeviceOutOfScope(req, res, device) {
    if (await deviceGroupService.userCanAccessDevice(db, req.session.user, device)) return false;
    res.status(403).json({ success: false, error: req.t('errors.forbidden') });
    return true;
}

/**
 * GET /api/device-groups - List device groups for the panel.
 */
router.get('/api/device-groups', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const devices = await getVisibleDevicesForRequest(req);
        const groups = await getVisibleDeviceGroupsForRequest(req);
        const enriched = await deviceGroupService.enrichGroups(db, groups, devices);
        res.json({
            success: true,
            data: { groups: enriched, total: enriched.length }
        });
    } catch (err) {
        console.error('Get device groups error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/device-groups - Create or update a device group.
 */
router.post('/api/device-groups', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const payload = deviceGroupService.normalizeGroupPayload(req.body || {});
        if (!payload.name) {
            return res.status(400).json({ success: false, error: req.t('folders.name_required') });
        }
        if (payload.source_type === 'tag' && !payload.tag_filter) {
            return res.status(400).json({ success: false, error: req.t('devices.group_tag_required') });
        }
        if (!areValidGroupGuids(payload.allowed_groups)) {
            return res.status(400).json({ success: false, error: req.t('devices.group_invalid') });
        }

        let group;
        if (payload.guid) {
            if (!isValidGroupGuid(payload.guid)) {
                return res.status(400).json({ success: false, error: req.t('devices.group_invalid') });
            }
            if (deviceGroupService.folderIdFromGroupGuid(payload.guid) !== null) {
                return res.status(400).json({ success: false, error: req.t('devices.folder_group_readonly') });
            }
            group = await db.updateDeviceGroup(
                payload.guid,
                deviceGroupService.buildDeviceGroupUpdateFields(payload)
            );
            if (!group) {
                return res.status(404).json({ success: false, error: req.t('devices.group_not_found') });
            }
        } else {
            group = await db.createDeviceGroup(deviceGroupService.buildDeviceGroupCreateFields(payload));
        }

        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_users')) {
            group = await db.setDeviceGroupUserAccess(group.guid, payload.allowed_users);
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_groups')) {
            group = await db.setDeviceGroupUserGroupAccess(group.guid, payload.allowed_groups);
        }

        await db.logAction(req.session.userId, 'device_group_saved', `Device group ${group.name} saved`, req.ip);
        res.json({ success: true, data: group });
    } catch (err) {
        console.error('Save device group error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * DELETE /api/device-groups/:guid - Delete a device group.
 */
router.delete('/api/device-groups/:guid', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '');
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: req.t('devices.group_invalid') });
        }
        const group = await db.getDeviceGroupByGuid(guid);
        if (!group) {
            return res.status(404).json({ success: false, error: req.t('devices.group_not_found') });
        }
        if (deviceGroupService.folderIdFromGroupGuid(guid) !== null) {
            return res.status(400).json({ success: false, error: req.t('devices.folder_group_readonly') });
        }
        await db.deleteDeviceGroup(guid);
        await db.logAction(req.session.userId, 'device_group_deleted', `Device group ${group.name} deleted`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete device group error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/devices/:id/groups - Get manual and dynamic memberships for a device.
 */
router.get('/api/devices/:id/groups', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const device = await serverBackend.getDeviceById(req.params.id);
        if (!device) return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        const allDevices = await getVisibleDevicesForRequest(req);
        if (!await deviceGroupService.userCanAccessDevice(db, req.session.user, device, allDevices)) {
            return res.status(403).json({ success: false, error: req.t('errors.forbidden') });
        }
        const groups = await deviceGroupService.enrichGroups(db, await getVisibleDeviceGroupsForRequest(req), allDevices);
        const memberships = groups.filter(group => {
            if (group.source_type === 'tag') return deviceGroupService.normalizeTags(device.tags).some(t => t.toLowerCase() === String(group.tag_filter || '').toLowerCase());
            return false;
        });
        const manual = await db.getDeviceGroupsForPeer(req.params.id);
        const manualGuids = new Set(manual.map(group => group.guid));
        for (const group of groups) {
            if (manualGuids.has(group.guid) && !memberships.some(g => g.guid === group.guid)) memberships.push(group);
        }
        res.json({ success: true, data: { groups, memberships } });
    } catch (err) {
        console.error('Get device memberships error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/devices/:id/groups - Replace manual group memberships for a device.
 */
router.put('/api/devices/:id/groups', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const deviceId = req.params.id;
        const groupGuids = Array.isArray(req.body.groupGuids) ? req.body.groupGuids.map(String) : [];
        if (groupGuids.length > 100 || groupGuids.some(guid => !isValidGroupGuid(guid))) {
            return res.status(400).json({ success: false, error: req.t('devices.group_invalid') });
        }

        const device = await serverBackend.getDeviceById(deviceId);
        if (!device) return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        const allDevices = await getVisibleDevicesForRequest(req);
        if (!await deviceGroupService.userCanAccessDevice(db, req.session.user, device, allDevices)) {
            return res.status(403).json({ success: false, error: req.t('errors.forbidden') });
        }

        const groups = await getVisibleDeviceGroupsForRequest(req);
        const manualGroups = groups.filter(group => (group.source_type || 'manual') !== 'tag');
        const manualGuidSet = new Set(manualGroups.map(group => group.guid));
        const selected = Array.from(new Set(groupGuids.filter(guid => manualGuidSet.has(guid))));

        for (const group of manualGroups) {
            if (selected.includes(group.guid)) await db.addDeviceToGroup(group.guid, deviceId);
            else await db.removeDeviceFromGroup(group.guid, deviceId);
        }

        await db.logAction(req.session.userId, 'device_group_membership_updated', `Device ${deviceId} groups set to [${selected.join(', ')}]`, req.ip);
        res.json({ success: true, data: { groupGuids: selected } });
    } catch (err) {
        console.error('Update device memberships error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/devices/:id - Get single device with sysinfo and latest metrics
 */
router.get('/api/devices/:id', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        let device = await serverBackend.getDeviceById(req.params.id);
        if (!device) {
            device = await serverBackend.getDeviceById(req.params.id, { includeDeleted: true });
        }
        
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;

        // Enrich with sysinfo data (from peer_sysinfo table)
        try {
            const sysinfo = await db.getPeerSysinfo(req.params.id);
            if (sysinfo) {
                device.sysinfo = sysinfo;
            }
        } catch (e) {
            // sysinfo table may not exist yet — silently skip
        }

        // Enrich with latest heartbeat metrics
        try {
            const latestMetric = await db.getLatestPeerMetric(req.params.id);
            if (latestMetric) {
                device.metrics = {
                    cpu_usage: latestMetric.cpu_usage,
                    memory_usage: latestMetric.memory_usage,
                    disk_usage: latestMetric.disk_usage,
                    updated_at: latestMetric.created_at
                };
            }
        } catch (e) {
            // metrics table may not exist yet — silently skip
        }

        // Enrich with recent metrics history (last 20 data-points for charts)
        try {
            const metricsHistory = await db.getPeerMetrics(req.params.id, 20);
            if (metricsHistory && metricsHistory.length > 0) {
                device.metrics_history = metricsHistory.map(m => ({
                    cpu: m.cpu_usage,
                    memory: m.memory_usage,
                    disk: m.disk_usage,
                    time: m.created_at
                }));
            }
        } catch (e) {
            // silently skip
        }

        // Enrich with device group memberships
        try {
            const groups = await db.getDeviceGroupsForPeer(req.params.id);
            if (groups && groups.length > 0) {
                device.groups = groups;
            }
        } catch (e) {
            // silently skip
        }

        res.json({
            success: true,
            data: device
        });
    } catch (err) {
        console.error('Get device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/devices/:id - Update device (name, note, display_name)
 */
router.patch('/api/devices/:id', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const user = req.body.user !== undefined ? String(req.body.user).trim().slice(0, 128) : undefined;
        const note = req.body.note !== undefined ? String(req.body.note).trim().slice(0, 512) : undefined;
        const display_name = req.body.display_name !== undefined ? String(req.body.display_name).trim().slice(0, 128) : undefined;
        const id = req.params.id;
        
        // Check device exists
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        
        const result = await serverBackend.updateDevice(id, { user, note, display_name });
        if (result && result.error) {
            return res.status(502).json({
                success: false,
                error: result.error
            });
        }
        
        // Log action
        try {
            await db.logAction(req.session.userId, 'device_updated', `Device ${id} updated`, req.ip);
        } catch (auditErr) {
            console.warn('Device update audit log failed:', auditErr.message);
        }
        
        res.json({
            success: true,
            data: { changes: result?.changes ?? 1 }
        });
    } catch (err) {
        console.error('Update device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/devices/:id - Delete device (soft delete)
 * Query params: revoke=true (blocklist + disconnect), cascade=true (delete linked devices)
 */
router.delete('/api/devices/:id', requireAuth, requirePermission('device.delete'), async (req, res) => {
    try {
        const id = req.params.id;
        const revoke = req.query.revoke === 'true';
        const cascade = req.query.cascade === 'true';
        const hard = req.query.hard === 'true';
        
        let device = await serverBackend.getDeviceById(id);
        if (!device && hard) {
            device = await serverBackend.getDeviceById(id, { includeDeleted: true });
        }
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        
        const result = await serverBackend.deleteDevice(id, { revoke, cascade, hard });
        
        if (!result || !result.success) {
            return res.status(500).json({
                success: false,
                error: result?.error || req.t('devices.delete_failed')
            });
        }
        
        // Clean up local auth.db data for this peer
        try {
            await db.cleanupDeletedPeerData(id);
            if (hard && typeof db.purgePanelPeerRecord === 'function') {
                await db.purgePanelPeerRecord(id);
            }
        } catch { /* non-critical: auth.db cleanup is secondary */ }
        
        // Log action
        const action = revoke ? 'device_revoked' : 'device_deleted';
        const details = revoke
            ? `Device ${id} revoked (blocklist + disconnect)${cascade ? ' + cascade' : ''}`
            : `Device ${id} deleted${hard ? ' permanently' : ''}`;
        await db.logAction(req.session.userId, action, details, req.ip);
        
        res.json({
            success: true,
            revoked: revoke,
            hard,
            cascaded: result.cascaded || [],
        });
    } catch (err) {
        console.error('Delete device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/restore - Restore a soft-deleted device
 */
router.post('/api/devices/:id/restore', requireAuth, requirePermission('device.delete'), async (req, res) => {
    try {
        const id = req.params.id;
        const result = await serverBackend.restoreDevice(id);
        if (!result || !result.success) {
            const status = result?.error === 'peer not found' ? 404 : 500;
            return res.status(status).json({
                success: false,
                error: result?.error || req.t('devices.restore_failed')
            });
        }
        await db.logAction(req.session.userId, 'device_restored', `Device ${id} restored`, req.ip);
        res.json({ success: true, data: result.data || result });
    } catch (err) {
        console.error('Restore device error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/devices/:id/ban - Ban device
 */
router.post('/api/devices/:id/ban', requireAuth, requirePermission('device.ban'), async (req, res) => {
    try {
        const id = req.params.id;
        const { reason } = req.body;
        
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        
        await serverBackend.setBanStatus(id, true, reason || '');
        
        // Log action
        await db.logAction(req.session.userId, 'device_banned', `Device ${id} banned: ${reason}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Ban device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/unban - Unban device
 */
router.post('/api/devices/:id/unban', requireAuth, requirePermission('device.ban'), async (req, res) => {
    try {
        const id = req.params.id;
        
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        
        await serverBackend.setBanStatus(id, false);
        
        // Log action
        await db.logAction(req.session.userId, 'device_unbanned', `Device ${id} unbanned`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Unban device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/change-id - Change device ID
 */
router.post('/api/devices/:id/change-id', requireAuth, requirePermission('device.change_id'), async (req, res) => {
    try {
        const oldId = req.params.id;
        const { newId } = req.body;
        
        if (!newId || newId.length < 6 || newId.length > 16) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.invalid_id')
            });
        }
        
        // Validate format (alphanumeric + dash + underscore)
        if (!/^[A-Za-z0-9_-]+$/.test(newId)) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.invalid_id_format')
            });
        }
        
        // Check if new ID already exists (active or soft-deleted reservation)
        const existingActive = await serverBackend.getDeviceById(newId);
        if (existingActive) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.id_exists')
            });
        }
        const existingDeleted = await serverBackend.getDeviceById(newId, { includeDeleted: true });
        if (existingDeleted?.soft_deleted) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.id_reserved_deleted')
            });
        }
        
        // Try to change via server backend API
        const result = await serverBackend.changePeerId(oldId, newId);
        
        if (!result || !result.success) {
            return res.status(400).json({
                success: false,
                error: mapChangeIdError(req, result?.error)
            });
        }

        try {
            if (typeof db.cascadePeerIdChange === 'function') {
                await db.cascadePeerIdChange(oldId, newId);
            }
        } catch (cascadeErr) {
            console.warn('Change ID panel cascade failed:', cascadeErr.message);
        }
        
        // Log action
        await db.logAction(req.session.userId, 'device_id_changed', `Device ID changed from ${oldId} to ${newId}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Change ID error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PUT /api/devices/:id/tags - Set device tags
 */
router.put('/api/devices/:id/tags', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const id = req.params.id;
        const { tags } = req.body;

        if (!Array.isArray(tags)) {
            return res.status(400).json({
                success: false,
                error: 'Tags must be an array'
            });
        }

        // Validate tag values: non-empty strings, max 50 chars each, max 20 tags
        const cleaned = tags
            .filter(t => typeof t === 'string' && t.trim().length > 0)
            .map(t => t.trim().slice(0, 50));

        if (cleaned.length > 20) {
            return res.status(400).json({
                success: false,
                error: 'Maximum 20 tags allowed'
            });
        }

        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }

        // BetterDesk backend: delegate to Go server
        if (await serverBackend.isBetterDesk()) {
            const result = await serverBackend.setPeerTags(id, cleaned);
            if (!result || !result.success) {
                return res.status(400).json({
                    success: false,
                    error: result?.error || 'Failed to set tags'
                });
            }
        }
        // Note: in rustdesk mode, tags are not supported (no-op)

        // Log action
        await db.logAction(req.session.userId, 'device_tags_updated', `Device ${id} tags set to [${cleaned.join(', ')}]`, req.ip);

        res.json({
            success: true,
            data: { tags: cleaned }
        });
    } catch (err) {
        console.error('Set tags error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/bulk-delete - Delete multiple devices
 */
router.post('/api/devices/bulk-delete', requireAuth, requirePermission('device.delete'), async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.no_selection')
            });
        }
        
        const devicesToDelete = [];
        for (const id of ids) {
            const device = await serverBackend.getDeviceById(id);
            if (!device || await rejectIfDeviceOutOfScope(req, res, device)) return;
            devicesToDelete.push(String(id));
        }

        let deleted = 0;
        for (const id of devicesToDelete) {
            const result = await serverBackend.deleteDevice(id);
            // In betterdesk mode, result is {success, data}; in rustdesk, result has .changes
            if (result && (result.success || result.changes)) deleted++;
        }
        
        // Log action
        await db.logAction(req.session.userId, 'devices_bulk_deleted', `${deleted} devices deleted`, req.ip);
        
        res.json({
            success: true,
            data: { deleted }
        });
    } catch (err) {
        console.error('Bulk delete error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

// ============================================================
// Access Policies (Unattended Access Management)
// ============================================================

/**
 * GET /api/devices/:id/access-policy - Get access policy for a device
 */
router.get('/api/devices/:id/access-policy', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const device = await serverBackend.getDeviceById(req.params.id);
        if (!device) return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        const goApi = require('../services/betterdeskApi');
        const result = await goApi.getAccessPolicy(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('Get access policy error:', err);
        res.status(500).json({ success: false, error: 'Failed to get access policy' });
    }
});

/**
 * PUT /api/devices/:id/access-policy - Save access policy for a device
 */
router.put('/api/devices/:id/access-policy', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const device = await serverBackend.getDeviceById(req.params.id);
        if (!device) return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        const goApi = require('../services/betterdeskApi');
        const result = await goApi.saveAccessPolicy(req.params.id, req.body);
        res.json(result);
    } catch (err) {
        console.error('Save access policy error:', err);
        res.status(500).json({ success: false, error: 'Failed to save access policy' });
    }
});

/**
 * DELETE /api/devices/:id/access-policy - Delete access policy for a device
 */
router.delete('/api/devices/:id/access-policy', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const device = await serverBackend.getDeviceById(req.params.id);
        if (!device) return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        if (await rejectIfDeviceOutOfScope(req, res, device)) return;
        const goApi = require('../services/betterdeskApi');
        const result = await goApi.deleteAccessPolicy(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('Delete access policy error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete access policy' });
    }
});

// ===========================================================================
//  Phase 2 — Live agent introspection (services, processes, events, files,
//  terminal, screenshot, activity). All endpoints proxy a command request to
//  the agent over the signal WebSocket (bdRelay.requestFromDevice) and return
//  the agent's reply. If the agent is offline, 503 is returned.
// ===========================================================================

const bdRelay = require('../services/bdRelay');

/**
 * Wrap an agent-proxy request with consistent error handling and timeout.
 * Distinct error codes help the UI render appropriate states.
 */
async function proxyAgentRequest(req, res, type, payload = null, timeoutMs = 15000) {
    try {
        const data = await bdRelay.requestFromDevice(req.params.id, type, payload, timeoutMs);
        res.json({ success: true, data });
    } catch (err) {
        const msg = err && err.message ? err.message : 'agent_error';
        const status = msg === 'agent_offline' ? 503
            : msg === 'agent_timeout' ? 504
            : 502;
        res.status(status).json({ success: false, error: msg });
    }
}

/** GET /api/devices/:id/services — live OS services list */
router.get('/api/devices/:id/services', requireAuth, requirePermission('device.view'), (req, res) => {
    proxyAgentRequest(req, res, 'services.list');
});

/** GET /api/devices/:id/processes — live process list */
router.get('/api/devices/:id/processes', requireAuth, requirePermission('device.view'), (req, res) => {
    proxyAgentRequest(req, res, 'processes.list');
});

/** GET /api/devices/:id/events?limit=100 — recent OS event log / journalctl */
router.get('/api/devices/:id/events', requireAuth, requirePermission('device.view'), (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    proxyAgentRequest(req, res, 'events.list', { limit });
});

/** GET /api/devices/:id/activity — live activity tracker (app usage) */
router.get('/api/devices/:id/activity', requireAuth, requirePermission('device.view'), (req, res) => {
    proxyAgentRequest(req, res, 'activity.get');
});

/**
 * POST /api/devices/:id/files/browse
 * Body: { path: '/some/folder', show_hidden: false }
 */
router.post('/api/devices/:id/files/browse', requireAuth, requirePermission('device.edit'), (req, res) => {
    const path = bodyString(req.body?.path, '').slice(0, 4096);
    const showHidden = bodyBool(req.body?.show_hidden, false);
    proxyAgentRequest(req, res, 'files.browse', { path, show_hidden: showHidden });
});

/**
 * POST /api/devices/:id/files/read
 * Body: { path, offset, length }
 */
router.post('/api/devices/:id/files/read', requireAuth, requirePermission('device.edit'), (req, res) => {
    const body = plainBodyObject(req.body);
    const path = bodyString(body.path, '').slice(0, 4096);
    const offset = bodyInt(body.offset, 0, { min: 0 });
    const length = bodyInt(body.length, 65536, { min: 0, max: 1024 * 1024 });
    proxyAgentRequest(req, res, 'files.read', { path, offset, length }, 30000);
});

/**
 * POST /api/devices/:id/files/write   (Phase 63)
 * Body: { path, data: <base64>, mode?: 'overwrite|append|create' }
 * Max payload ~16 MB (enforced agent-side). Audited.
 */
router.post('/api/devices/:id/files/write', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const path = String(req.body?.path || '').slice(0, 4096);
    const data = String(req.body?.data || '');
    const mode = ['overwrite', 'append', 'create'].includes(req.body?.mode) ? req.body.mode : 'overwrite';
    if (!path) return res.status(400).json({ success: false, error: 'path_required' });
    if (data.length > 22 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'payload_too_large' });
    }
    try {
        await db.logAction(req.session.userId, 'files.write',
            `Write ${mode} on ${req.params.id}: ${path}`, req.ip || null);
    } catch (_) { /* non-fatal */ }
    proxyAgentRequest(req, res, 'files.write', { path, data, mode }, 30000);
});

/**
 * POST /api/devices/:id/files/delete   (Phase 63)
 * Body: { path, recursive?: bool }
 */
router.post('/api/devices/:id/files/delete', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const path = String(req.body?.path || '').slice(0, 4096);
    const recursive = req.body?.recursive === true;
    if (!path) return res.status(400).json({ success: false, error: 'path_required' });
    try {
        await db.logAction(req.session.userId, 'files.delete',
            `Delete${recursive ? ' (recursive)' : ''} on ${req.params.id}: ${path}`, req.ip || null);
    } catch (_) { /* non-fatal */ }
    proxyAgentRequest(req, res, 'files.delete', { path, recursive }, 15000);
});

/**
 * POST /api/devices/:id/files/rename   (Phase 63)
 * Body: { from, to }
 */
router.post('/api/devices/:id/files/rename', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const from = String(req.body?.from || '').slice(0, 4096);
    const to = String(req.body?.to || '').slice(0, 4096);
    if (!from || !to) return res.status(400).json({ success: false, error: 'paths_required' });
    try {
        await db.logAction(req.session.userId, 'files.rename',
            `Rename on ${req.params.id}: ${from} -> ${to}`, req.ip || null);
    } catch (_) { /* non-fatal */ }
    proxyAgentRequest(req, res, 'files.rename', { from, to }, 10000);
});

/**
 * POST /api/devices/:id/files/mkdir   (Phase 63)
 * Body: { path, recursive?: bool (default true) }
 */
router.post('/api/devices/:id/files/mkdir', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const path = String(req.body?.path || '').slice(0, 4096);
    const recursive = req.body?.recursive !== false;
    if (!path) return res.status(400).json({ success: false, error: 'path_required' });
    try {
        await db.logAction(req.session.userId, 'files.mkdir',
            `Mkdir on ${req.params.id}: ${path}`, req.ip || null);
    } catch (_) { /* non-fatal */ }
    proxyAgentRequest(req, res, 'files.mkdir', { path, recursive }, 10000);
});

/**
 * GET /api/devices/:id/clipboard   (Phase 64)
 * Reads the device's text clipboard.
 */
router.get('/api/devices/:id/clipboard', requireAuth, requirePermission('device.view'), (req, res) => {
    proxyAgentRequest(req, res, 'clipboard.get', null, 5000);
});

/**
 * POST /api/devices/:id/clipboard   (Phase 64)
 * Body: { text }   (max 1 MiB enforced agent-side)
 */
router.post('/api/devices/:id/clipboard', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (text.length > 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'text_too_large' });
    }
    try {
        await db.logAction(req.session.userId, 'clipboard.set',
            `Clipboard set on ${req.params.id} (${text.length} chars)`, req.ip || null);
    } catch (_) { /* non-fatal */ }
    proxyAgentRequest(req, res, 'clipboard.set', { text }, 5000);
});

/**
 * POST /api/devices/:id/screenshot
 * Captures a JPEG snapshot from the agent. Returns base64 image.
 */
router.post('/api/devices/:id/screenshot', requireAuth, requirePermission('device.view'), (req, res) => {
    proxyAgentRequest(req, res, 'screenshot.capture', null, 20000);
});

/**
 * POST /api/devices/:id/input/mouse
 * Body: { action: 'move|down|up|click|wheel', x?, y?, x_rel?, y_rel?,
 *         screen_w?, screen_h?, button?: 'left|right|middle',
 *         wheel_dx?, wheel_dy? }
 * Forwards a single mouse event to the agent (Phase 58).
 */
router.post('/api/devices/:id/input/mouse', requireAuth, requirePermission('device.edit'), (req, res) => {
    const b = req.body || {};
    const payload = {
        action: String(b.action || 'move'),
        button: typeof b.button === 'string' ? b.button : undefined,
    };
    if (typeof b.x === 'number') payload.x = Math.trunc(b.x);
    if (typeof b.y === 'number') payload.y = Math.trunc(b.y);
    if (typeof b.x_rel === 'number') payload.x_rel = b.x_rel;
    if (typeof b.y_rel === 'number') payload.y_rel = b.y_rel;
    if (typeof b.screen_w === 'number') payload.screen_w = Math.trunc(b.screen_w);
    if (typeof b.screen_h === 'number') payload.screen_h = Math.trunc(b.screen_h);
    if (typeof b.wheel_dx === 'number') payload.wheel_dx = Math.trunc(b.wheel_dx);
    if (typeof b.wheel_dy === 'number') payload.wheel_dy = Math.trunc(b.wheel_dy);
    proxyAgentRequest(req, res, 'input.mouse', payload, 5000);
});

/**
 * POST /api/devices/:id/input/key
 * Body: { key: 'Enter|Escape|a|F5|...', action?: 'press|down|up' }
 */
router.post('/api/devices/:id/input/key', requireAuth, requirePermission('device.edit'), (req, res) => {
    const key = String(req.body?.key || '').slice(0, 32);
    if (!key) return res.status(400).json({ success: false, error: 'key_required' });
    const action = String(req.body?.action || 'press');
    proxyAgentRequest(req, res, 'input.key', { key, action }, 5000);
});

/**
 * POST /api/devices/:id/input/text
 * Body: { text: 'hello world' }
 */
router.post('/api/devices/:id/input/text', requireAuth, requirePermission('device.edit'), (req, res) => {
    const text = String(req.body?.text || '').slice(0, 4096);
    if (!text) return res.status(400).json({ success: false, error: 'text_required' });
    proxyAgentRequest(req, res, 'input.text', { text }, 8000);
});

/**
 * POST /api/devices/:id/terminal/execute
 * Body: { command: 'ls -la /tmp' }
 * One-shot command execution (no PTY). For interactive terminal use the WS
 * endpoint (future Phase 4 integration).
 */
router.post('/api/devices/:id/terminal/execute', requireAuth, requirePermission('device.edit'), async (req, res) => {
    const command = String(req.body?.command || '').slice(0, 4096);
    if (!command.trim()) {
        return res.status(400).json({ success: false, error: 'command_required' });
    }
    // Audit this — terminal execution is a sensitive action.
    try {
        await db.logAction(req.session.userId, 'terminal.execute',
            `Terminal command on ${req.params.id}: ${command.substring(0, 200)}`,
            req.ip || null);
    } catch (_) { /* audit failure should not block the command */ }
    proxyAgentRequest(req, res, 'terminal.execute', { command }, 30000);
});

/**
 * POST /api/devices/:id/rename
 * Body: { display_name: 'Accounting PC 3' }
 * Convenience alias for the display_name branch of PATCH /api/devices/:id.
 */
router.post('/api/devices/:id/rename', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const displayName = String(req.body?.display_name || '').trim().slice(0, 200);
        if (!displayName) {
            return res.status(400).json({ success: false, error: 'display_name_required' });
        }
        const device = await serverBackend.getDeviceById(req.params.id);
        if (!device) {
            return res.status(404).json({ success: false, error: req.t('devices.not_found') });
        }
        const result = await serverBackend.updateDevice(req.params.id, { display_name: displayName });
        await db.logAction(req.session.userId, 'device.rename',
            `Device ${req.params.id} renamed to "${displayName}"`, req.ip || null);
        res.json({ success: true, data: { changes: result?.changes ?? 1, display_name: displayName } });
    } catch (err) {
        console.error('Rename device error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ---------------------------------------------------------------------------
// Panel access-control strategies (RustDesk Pro client policy rules)
// ---------------------------------------------------------------------------

const RUSTDESK_STRATEGY_PERM_KEYS = [
    'enable-file-transfer',
    'disable-clipboard',
    'enable-clipboard',
    'enable-audio',
    'enable-tunnel',
    'enable-camera',
    'enable-remote-restart',
    'enable-block-input',
];

function normalizeStrategyPermissions(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (value === true || value === 'Y' || value === 'y') out[key] = 'Y';
        else if (value === false || value === 'N' || value === 'n') out[key] = 'N';
        else if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
}

function serializeStrategy(row) {
    if (!row) return null;
    const perms = row.permissions && typeof row.permissions === 'object' ? row.permissions : {};
    return {
        guid: row.guid,
        name: row.name || '',
        user_group_guid: row.user_group_guid || '',
        device_group_guid: row.device_group_guid || '',
        enabled: row.enabled === true || row.enabled === 1,
        permissions: perms,
        permission_keys: RUSTDESK_STRATEGY_PERM_KEYS,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
    };
}

function normalizeStrategyPayload(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) {
        const err = new Error('Strategy name is required');
        err.status = 400;
        throw err;
    }
    const userGroupGuid = String(body.user_group_guid || '').trim();
    const deviceGroupGuid = String(body.device_group_guid || '').trim();
    if (userGroupGuid && !isValidGroupGuid(userGroupGuid)) {
        const err = new Error('Invalid user group');
        err.status = 400;
        throw err;
    }
    if (deviceGroupGuid && !isValidGroupGuid(deviceGroupGuid)) {
        const err = new Error('Invalid device group');
        err.status = 400;
        throw err;
    }
    return {
        name: name.slice(0, 80),
        user_group_guid: userGroupGuid,
        device_group_guid: deviceGroupGuid,
        enabled: body.enabled !== false,
        permissions: normalizeStrategyPermissions(body.permissions),
    };
}

/**
 * GET /api/panel/strategies — list strategies for panel UI / RustDesk sync.
 */
router.get('/api/panel/strategies', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const strategies = await db.getAllStrategies();
        res.json({
            success: true,
            data: {
                strategies: (strategies || []).map(serializeStrategy),
                total: strategies.length,
            },
        });
    } catch (err) {
        console.error('Get strategies error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/panel/strategies — create strategy.
 */
router.post('/api/panel/strategies', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const payload = normalizeStrategyPayload(req.body || {});
        const created = await db.createStrategy(payload);
        await db.logAction(req.session.userId, 'strategy_created', `Created strategy: ${created.name}`, req.ip);
        res.json({ success: true, data: { strategy: serializeStrategy(created) } });
    } catch (err) {
        console.error('Create strategy error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error'),
        });
    }
});

/**
 * PATCH /api/panel/strategies/:guid — update strategy.
 */
router.patch('/api/panel/strategies/:guid', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid strategy identifier' });
        }
        const existing = await db.getStrategyByGuid(guid);
        if (!existing) {
            return res.status(404).json({ success: false, error: req.t('devices.strategy_not_found') });
        }
        const payload = normalizeStrategyPayload({ ...existing, ...req.body });
        const updated = await db.updateStrategy(guid, payload);
        await db.logAction(req.session.userId, 'strategy_updated', `Updated strategy: ${updated.name}`, req.ip);
        res.json({ success: true, data: { strategy: serializeStrategy(updated) } });
    } catch (err) {
        console.error('Update strategy error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error'),
        });
    }
});

async function resolveStrategyAssignKeys(body = {}) {
    const peers = [];
    for (const ref of body.peers || []) {
        peers.push(await db.resolvePeerAssignmentKey(ref));
    }
    const users = [];
    for (const ref of body.users || []) {
        users.push(await db.resolveUserAssignmentKey(ref));
    }
    const groups = [];
    for (const ref of body.groups || []) {
        groups.push(await db.resolveDeviceGroupAssignmentKey(ref));
    }
    return { peers, users, groups };
}

async function syncStrategyAssignToGo(strategyGuid, body = {}) {
    if (!(await serverBackend.isBetterDesk())) return;
    try {
        await betterdeskApi.assignStrategy({
            strategy: strategyGuid || undefined,
            peers: body.peers || [],
            users: body.users || [],
            groups: body.groups || [],
        });
    } catch (err) {
        console.warn('[strategies] Go assign sync failed:', err.message);
    }
}

/**
 * GET /api/panel/strategies/:guid — strategy details + direct assignments.
 */
router.get('/api/panel/strategies/:guid', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid strategy identifier' });
        }
        let strategy = await db.getStrategyByGuid(guid);
        if (!strategy && (await serverBackend.isBetterDesk())) {
            const remote = await betterdeskApi.getStrategy(guid);
            if (remote.success !== false && remote.guid) strategy = remote;
        }
        if (!strategy) {
            return res.status(404).json({ success: false, error: req.t('devices.strategy_not_found') });
        }
        const summary = await db.getStrategyAssignmentDisplayRefs(guid);
        res.json({
            success: true,
            data: {
                strategy: {
                    ...serializeStrategy(strategy),
                    ...summary,
                },
            },
        });
    } catch (err) {
        console.error('Get strategy detail error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/panel/strategies/:guid/assign — assign strategy to devices/users/groups.
 */
router.post('/api/panel/strategies/:guid/assign', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid strategy identifier' });
        }
        const existing = await db.getStrategyByGuid(guid);
        if (!existing) {
            return res.status(404).json({ success: false, error: req.t('devices.strategy_not_found') });
        }
        const body = req.body || {};
        if (!(body.peers?.length || body.users?.length || body.groups?.length)) {
            return res.status(400).json({ success: false, error: 'At least one target is required' });
        }
        const resolved = await resolveStrategyAssignKeys(body);
        await db.assignStrategy(guid, resolved);
        await syncStrategyAssignToGo(guid, body);
        const summary = await db.getStrategyAssignmentSummary(guid);
        await db.logAction(req.session.userId, 'strategy_assigned', `Assigned strategy: ${existing.name}`, req.ip);
        res.json({ success: true, data: { summary } });
    } catch (err) {
        console.error('Assign strategy error:', err);
        res.status(err.message?.includes('not found') ? 400 : 500).json({
            success: false,
            error: err.message?.includes('not found') ? err.message : req.t('errors.server_error'),
        });
    }
});

/**
 * POST /api/panel/strategies/unassign — remove direct assignments (empty strategy).
 */
router.post('/api/panel/strategies/unassign', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const body = req.body || {};
        if (!(body.peers?.length || body.users?.length || body.groups?.length)) {
            return res.status(400).json({ success: false, error: 'At least one target is required' });
        }
        const resolved = await resolveStrategyAssignKeys(body);
        await db.assignStrategy('', resolved);
        await syncStrategyAssignToGo('', body);
        res.json({ success: true });
    } catch (err) {
        console.error('Unassign strategy error:', err);
        res.status(400).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * DELETE /api/panel/strategies/:guid — delete strategy.
 */
router.delete('/api/panel/strategies/:guid', requireAuth, requirePermission('device.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid strategy identifier' });
        }
        const existing = await db.getStrategyByGuid(guid);
        if (!existing) {
            return res.status(404).json({ success: false, error: req.t('devices.strategy_not_found') });
        }
        await db.deleteStrategy(guid);
        await db.logAction(req.session.userId, 'strategy_deleted', `Deleted strategy: ${existing.name}`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete strategy error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

module.exports = router;
