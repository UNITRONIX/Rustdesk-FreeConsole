/**
 * BetterDesk Console - Devices Routes Tests
 */

const request = require('supertest');
const { createTestApp } = require('./helpers');

// Mock dependencies
jest.mock('../services/database', () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    getPeerSysinfo: jest.fn().mockResolvedValue(null),
    getLatestPeerMetric: jest.fn().mockResolvedValue(null),
    getPeerMetrics: jest.fn().mockResolvedValue([]),
    getDeviceGroupsForPeer: jest.fn().mockResolvedValue([]),
    getDeviceGroupAccessForUser: jest.fn().mockResolvedValue([]),
    getUserGroupsForUser: jest.fn().mockResolvedValue([]),
    getAllDeviceGroups: jest.fn().mockResolvedValue([]),
    getDeviceGroupMembers: jest.fn().mockResolvedValue([]),
    getDeviceGroupByGuid: jest.fn().mockResolvedValue(null),
    createDeviceGroup: jest.fn().mockResolvedValue({ guid: 'group-1', name: 'Group 1', source_type: 'manual', tag_filter: '', allowed_users: [] }),
    updateDeviceGroup: jest.fn().mockResolvedValue(null),
    deleteDeviceGroup: jest.fn().mockResolvedValue(undefined),
    setDeviceGroupUserAccess: jest.fn().mockImplementation((_guid, users) => Promise.resolve({ guid: 'group-1', name: 'Group 1', allowed_users: users })),
    setDeviceGroupUserGroupAccess: jest.fn().mockImplementation((_guid, groups) => Promise.resolve({ guid: 'group-1', name: 'Group 1', allowed_groups: groups })),
    addDeviceToGroup: jest.fn().mockResolvedValue(undefined),
    removeDeviceFromGroup: jest.fn().mockResolvedValue(undefined),
    getAllFolders: jest.fn().mockResolvedValue([]),
    getAllFolderAssignments: jest.fn().mockResolvedValue({}),
    cleanupDeletedPeerData: jest.fn().mockResolvedValue(undefined),
    cascadePeerIdChange: jest.fn().mockResolvedValue(undefined),
    purgePanelPeerRecord: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/serverBackend', () => ({
    getAllDevices: jest.fn().mockResolvedValue([]),
    getDeviceById: jest.fn().mockResolvedValue(null),
    updateDevice: jest.fn().mockResolvedValue(undefined),
    deleteDevice: jest.fn().mockResolvedValue(undefined),
    restoreDevice: jest.fn().mockResolvedValue({ success: true }),
    changePeerId: jest.fn().mockResolvedValue({ success: true })
}));

const serverBackend = require('../services/serverBackend');
const db = require('../services/database');
const devicesRoutes = require('../routes/devices.routes');

describe('Devices Routes', () => {
    let app;

    beforeEach(() => {
        app = createTestApp();
        // Inject auth for all requests
        app.use((req, _res, next) => {
            req.session.userId = 1;
            req.session.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        });
        app.use('/', devicesRoutes);
        jest.clearAllMocks();
    });

    describe('GET /api/devices', () => {
        it('should return empty device list', async () => {
            serverBackend.getAllDevices.mockResolvedValue([]);

            const res = await request(app).get('/api/devices');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.devices).toEqual([]);
            expect(res.body.data.total).toBe(0);
        });

        it('should return devices with default sort', async () => {
            const mockDevices = [
                { id: '123456789', hostname: 'PC-1', last_online: '2026-03-26T12:00:00Z' },
                { id: '987654321', hostname: 'PC-2', last_online: '2026-03-25T12:00:00Z' }
            ];
            serverBackend.getAllDevices.mockResolvedValue(mockDevices);

            const res = await request(app).get('/api/devices');

            expect(res.status).toBe(200);
            expect(res.body.data.devices).toHaveLength(2);
            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(
                expect.objectContaining({
                    sortBy: 'last_online',
                    sortOrder: 'desc'
                })
            );
        });

        it('should sanitize sort parameters', async () => {
            serverBackend.getAllDevices.mockResolvedValue([]);

            await request(app).get('/api/devices?sortBy=DROP_TABLE&sortOrder=INJECT');

            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(
                expect.objectContaining({
                    sortBy: 'last_online',
                    sortOrder: 'desc'
                })
            );
        });

        it('should accept valid sort parameters', async () => {
            serverBackend.getAllDevices.mockResolvedValue([]);

            await request(app).get('/api/devices?sortBy=hostname&sortOrder=asc');

            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(
                expect.objectContaining({
                    sortBy: 'hostname',
                    sortOrder: 'asc'
                })
            );
        });

        it('should pass search filter', async () => {
            serverBackend.getAllDevices.mockResolvedValue([]);

            await request(app).get('/api/devices?search=test');

            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test'
                })
            );
        });

        it('should pass includeDeleted filter', async () => {
            serverBackend.getAllDevices.mockResolvedValue([]);

            await request(app).get('/api/devices?includeDeleted=true');

            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(
                expect.objectContaining({
                    includeDeleted: true
                })
            );
        });
    });

    describe('GET /api/devices/:id', () => {
        it('should return 404 for unknown device', async () => {
            serverBackend.getDeviceById.mockResolvedValue(null);

            const res = await request(app).get('/api/devices/UNKNOWN');

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
        });

        it('should return device with sysinfo and metrics', async () => {
            serverBackend.getDeviceById.mockResolvedValue({
                id: '123456789',
                hostname: 'PC-1'
            });
            db.getPeerSysinfo.mockResolvedValue({
                hostname: 'PC-1',
                os: 'Windows 11',
                version: '10.0'
            });
            db.getLatestPeerMetric.mockResolvedValue({
                cpu_usage: 45.2,
                memory_usage: 67.8,
                disk_usage: 55.0,
                created_at: '2026-03-26T12:00:00Z'
            });

            const res = await request(app).get('/api/devices/123456789');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.id).toBe('123456789');
            expect(res.body.data.sysinfo).toBeDefined();
            expect(res.body.data.sysinfo.os).toBe('Windows 11');
            expect(res.body.data.metrics).toBeDefined();
            expect(res.body.data.metrics.cpu_usage).toBe(45.2);
        });

        it('should return device even if sysinfo fails', async () => {
            serverBackend.getDeviceById.mockResolvedValue({
                id: '123456789',
                hostname: 'PC-1'
            });
            db.getPeerSysinfo.mockRejectedValue(new Error('table missing'));

            const res = await request(app).get('/api/devices/123456789');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.id).toBe('123456789');
        });
    });

    describe('GET /api/tags', () => {
        it('should return unique device tags without folder names', async () => {
            serverBackend.getAllDevices.mockResolvedValue([
                { id: '123456789', tags: ['Internal', 'Windows'], folder_id: 1 },
                { id: '987654321', tags: 'External,Windows' }
            ]);
            db.getAllFolders.mockResolvedValue([{ id: 1, name: 'Servers' }]);
            db.getAllFolderAssignments.mockResolvedValue({ '123456789': 1 });

            const res = await request(app).get('/api/tags');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.tags).toEqual(['External', 'Internal', 'Windows']);
        });
    });

    describe('Device groups', () => {
        it('should count dynamic tag groups from visible devices', async () => {
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'LINUX1', tags: ['Linux', 'Kiosk'] },
                { id: 'WIN1', tags: ['Windows'] }
            ]);
            db.getAllDeviceGroups.mockResolvedValue([
                { guid: 'linux', name: 'Linux Devices', source_type: 'tag', tag_filter: 'Linux', allowed_users: [] }
            ]);

            const res = await request(app).get('/api/device-groups');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.groups[0].member_count).toBe(1);
        });

        it('should create a dynamic group with allowed users and user groups', async () => {
            db.createDeviceGroup.mockResolvedValue({ guid: 'group-1', name: 'Linux', source_type: 'tag', tag_filter: 'Linux' });

            const res = await request(app)
                .post('/api/device-groups')
                .send({
                    name: 'Linux',
                    source_type: 'tag',
                    tag_filter: 'Linux',
                    allowed_users: 'operator1, operator2',
                    allowed_groups: ['volunteers']
                });

            expect(res.status).toBe(200);
            expect(db.createDeviceGroup).toHaveBeenCalledWith(expect.objectContaining({
                name: 'Linux',
                source_type: 'tag',
                tag_filter: 'Linux'
            }));
            expect(db.setDeviceGroupUserAccess).toHaveBeenCalledWith('group-1', ['operator1', 'operator2']);
            expect(db.setDeviceGroupUserGroupAccess).toHaveBeenCalledWith('group-1', ['volunteers']);
        });

        it('should preserve team_id when switching an org group to tag mode without resending team_id', async () => {
            db.updateDeviceGroup.mockResolvedValue({
                guid: 'org-group-1',
                name: 'Org Devices',
                team_id: 'org-abc',
                source_type: 'tag',
                tag_filter: 'Linux'
            });

            const res = await request(app)
                .post('/api/device-groups')
                .send({
                    guid: 'org-group-1',
                    name: 'Org Devices',
                    source_type: 'tag',
                    tag_filter: 'Linux'
                });

            expect(res.status).toBe(200);
            expect(db.updateDeviceGroup).toHaveBeenCalledWith('org-group-1', {
                name: 'Org Devices',
                source_type: 'tag',
                tag_filter: 'Linux'
            });
            expect(db.updateDeviceGroup.mock.calls[0][1]).not.toHaveProperty('team_id');
        });

        it('should preserve team_id when editing allowed users/groups without resending team_id (Refs #230)', async () => {
            db.updateDeviceGroup.mockResolvedValue({
                guid: 'org-group-1',
                name: 'Org Devices',
                team_id: 'org-abc',
                source_type: 'manual',
                tag_filter: ''
            });
            db.setDeviceGroupUserAccess.mockResolvedValueOnce({
                guid: 'org-group-1',
                name: 'Org Devices',
                allowed_users: ['operator1']
            });

            const res = await request(app)
                .post('/api/device-groups')
                .send({
                    guid: 'org-group-1',
                    name: 'Org Devices',
                    source_type: 'manual',
                    allowed_users: 'operator1',
                    allowed_groups: ['volunteers']
                });

            expect(res.status).toBe(200);
            expect(db.updateDeviceGroup).toHaveBeenCalledWith('org-group-1', {
                name: 'Org Devices',
                source_type: 'manual',
                tag_filter: ''
            });
            expect(db.updateDeviceGroup.mock.calls[0][1]).not.toHaveProperty('team_id');
            expect(db.setDeviceGroupUserAccess).toHaveBeenCalledWith('org-group-1', ['operator1']);
            expect(db.setDeviceGroupUserGroupAccess).toHaveBeenCalledWith('org-group-1', ['volunteers']);
        });

        it('should scope operator devices through user group ACLs', async () => {
            const scopedApp = createTestApp();
            scopedApp.use((req, _res, next) => {
                req.session.userId = 2;
                req.session.user = { id: 2, username: 'operator1', role: 'operator' };
                next();
            });
            scopedApp.use('/', devicesRoutes);

            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'LINUX1', tags: ['Linux'] },
                { id: 'WIN1', tags: ['Windows'] }
            ]);
            db.getUserGroupsForUser.mockResolvedValue([{ guid: 'volunteers', name: 'Volunteers' }]);
            db.getAllDeviceGroups.mockResolvedValue([
                { guid: 'linux', name: 'Linux', source_type: 'tag', tag_filter: 'Linux', allowed_groups: ['volunteers'], allowed_users: [] },
                { guid: 'windows', name: 'Windows', source_type: 'tag', tag_filter: 'Windows', allowed_groups: ['coordinators'], allowed_users: [] }
            ]);

            const res = await request(scopedApp).get('/api/devices');

            expect(res.status).toBe(200);
            expect(res.body.data.devices.map(device => device.id)).toEqual(['LINUX1']);
        });

        it('should hide devices in groups with empty ACL from non-admins', async () => {
            const scopedApp = createTestApp();
            scopedApp.use((req, _res, next) => {
                req.session.userId = 2;
                req.session.user = { id: 2, username: 'operator1', role: 'operator' };
                next();
            });
            scopedApp.use('/', devicesRoutes);

            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'SECRET1', tags: ['Secret'] },
                { id: 'OPEN1', tags: ['Open'] }
            ]);
            db.getUserGroupsForUser.mockResolvedValue([]);
            db.getAllDeviceGroups.mockResolvedValue([
                { guid: 'secret', name: 'Secret', source_type: 'tag', tag_filter: 'Secret', allowed_groups: [], allowed_users: [] }
            ]);

            const res = await request(scopedApp).get('/api/devices');

            expect(res.status).toBe(200);
            expect(res.body.data.devices.map(device => device.id)).toEqual(['OPEN1']);
        });

        it('should replace manual group memberships without touching dynamic groups', async () => {
            serverBackend.getDeviceById.mockResolvedValue({ id: '123456789', tags: ['Linux'] });
            serverBackend.getAllDevices.mockResolvedValue([{ id: '123456789', tags: ['Linux'] }]);
            db.getAllDeviceGroups.mockResolvedValue([
                { guid: 'manual-a', name: 'Manual A', source_type: 'manual' },
                { guid: 'tag-linux', name: 'Linux', source_type: 'tag', tag_filter: 'Linux' }
            ]);

            const res = await request(app)
                .put('/api/devices/123456789/groups')
                .send({ groupGuids: ['manual-a', 'tag-linux'] });

            expect(res.status).toBe(200);
            expect(db.addDeviceToGroup).toHaveBeenCalledWith('manual-a', '123456789');
            expect(db.addDeviceToGroup).not.toHaveBeenCalledWith('tag-linux', '123456789');
        });
    });

    describe('PATCH /api/devices/:id', () => {
        it('should update display name and note', async () => {
            serverBackend.getDeviceById.mockResolvedValue({ id: '123456789', hostname: 'PC-1' });
            serverBackend.updateDevice.mockResolvedValue({ changes: 1 });

            const res = await request(app)
                .patch('/api/devices/123456789')
                .send({ display_name: 'Accounting PC', note: 'Front desk' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.changes).toBe(1);
            expect(serverBackend.updateDevice).toHaveBeenCalledWith('123456789', {
                user: undefined,
                note: 'Front desk',
                display_name: 'Accounting PC'
            });
        });

        it('should return backend update errors instead of reporting success', async () => {
            serverBackend.getDeviceById.mockResolvedValue({ id: '123456789', hostname: 'PC-1' });
            serverBackend.updateDevice.mockResolvedValue({ changes: 0, error: 'Go API update failed' });

            const res = await request(app)
                .patch('/api/devices/123456789')
                .send({ display_name: 'Accounting PC' });

            expect(res.status).toBe(502);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Go API update failed');
        });

        it('should not fail the update when audit logging fails', async () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            serverBackend.getDeviceById.mockResolvedValue({ id: '123456789', hostname: 'PC-1' });
            serverBackend.updateDevice.mockResolvedValue({ changes: 1 });
            db.logAction.mockRejectedValueOnce(new Error('audit unavailable'));

            const res = await request(app)
                .patch('/api/devices/123456789')
                .send({ display_name: 'Accounting PC' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(warnSpy).toHaveBeenCalledWith('Device update audit log failed:', 'audit unavailable');
            warnSpy.mockRestore();
        });
    });

    describe('POST /api/devices/:id/change-id', () => {
        it('should return reserved-deleted error when target ID is soft-deleted', async () => {
            serverBackend.getDeviceById
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: 'MACPRO', soft_deleted: true });

            const res = await request(app)
                .post('/api/devices/NEWCLIENT/change-id')
                .send({ newId: 'MACPRO' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('devices.id_reserved_deleted');
        });

        it('should propagate soft-deleted ID conflicts from the backend', async () => {
            const message = 'This ID belongs to a deleted device. Restore or permanently delete that device before reusing the ID.';
            serverBackend.getDeviceById.mockResolvedValue(null);
            serverBackend.changePeerId.mockResolvedValue({ success: false, error: message });

            const res = await request(app)
                .post('/api/devices/NEWCLIENT/change-id')
                .send({ newId: 'MACPRO' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('devices.id_reserved_deleted');
        });

        it('should preserve mixed-case IDs when cascading panel peer ID change', async () => {
            serverBackend.getDeviceById.mockImplementation(async (id) => {
                if (id === 'MacPro') return { id: 'MacPro', online: true };
                return null;
            });
            serverBackend.changePeerId.mockResolvedValue({ success: true });

            const res = await request(app)
                .post('/api/devices/MacPro/change-id')
                .send({ newId: 'MacPro1' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(serverBackend.changePeerId).toHaveBeenCalledWith('MacPro', 'MacPro1');
            expect(db.cascadePeerIdChange).toHaveBeenCalledWith('MacPro', 'MacPro1');
        });
    });

    describe('DELETE /api/devices/:id', () => {
        it('should pass hard delete option through to the backend', async () => {
            serverBackend.getDeviceById.mockResolvedValue({ id: 'MACPRO', hostname: 'Mac Pro' });
            serverBackend.deleteDevice.mockResolvedValue({ success: true });

            const res = await request(app).delete('/api/devices/MACPRO?hard=true');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.hard).toBe(true);
            expect(serverBackend.deleteDevice).toHaveBeenCalledWith('MACPRO', {
                revoke: false,
                cascade: false,
                hard: true
            });
            expect(db.purgePanelPeerRecord).toHaveBeenCalledWith('MACPRO');
        });

        it('should hard delete a soft-deleted device when active lookup misses', async () => {
            serverBackend.getDeviceById
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: 'MACPRO', soft_deleted: true });
            serverBackend.deleteDevice.mockResolvedValue({ success: true });

            const res = await request(app).delete('/api/devices/MACPRO?hard=true');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(serverBackend.getDeviceById).toHaveBeenCalledWith('MACPRO', { includeDeleted: true });
            expect(serverBackend.deleteDevice).toHaveBeenCalledWith('MACPRO', {
                revoke: false,
                cascade: false,
                hard: true
            });
        });
    });

    describe('GET /api/devices (unauthenticated)', () => {
        it('should return 401 without session', async () => {
            const unauthApp = createTestApp();
            unauthApp.use('/', devicesRoutes);

            const res = await request(unauthApp).get('/api/devices');

            expect(res.status).toBe(401);
        });
    });
});
