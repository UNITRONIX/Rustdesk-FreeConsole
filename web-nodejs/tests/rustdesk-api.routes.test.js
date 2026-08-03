/**
 * BetterDesk Console - RustDesk Client API route tests
 */

const request = require('supertest');
const { createTestApp } = require('./helpers');

jest.mock('../services/database', () => ({
    getAllDevices: jest.fn(),
    getAllFolderAssignments: jest.fn(),
    getAllFolders: jest.fn(),
    getAllPeerSysinfo: jest.fn(),
    getAddressBook: jest.fn(),
    getAddressBookTags: jest.fn(),
    saveAddressBook: jest.fn(),
    getAllDeviceGroups: jest.fn(),
    getDeviceGroupByGuid: jest.fn(),
    getDeviceGroupMembers: jest.fn()
}));

jest.mock('../services/authService', () => ({
    validateAccessToken: jest.fn()
}));

jest.mock('../services/serverBackend', () => ({
    getAllDevices: jest.fn(),
    setPeerTags: jest.fn()
}));

const db = require('../services/database');
const authService = require('../services/authService');
const serverBackend = require('../services/serverBackend');
const rustdeskApiRoutes = require('../routes/rustdesk-api.routes');

describe('RustDesk Client API routes', () => {
    let app;

    beforeEach(() => {
        app = createTestApp();
        app.use('/', rustdeskApiRoutes);

        jest.clearAllMocks();
        authService.validateAccessToken.mockResolvedValue({ id: 2, username: 'viewer1', role: 'viewer' });
        db.getAllDevices.mockResolvedValue([
            { id: 'OWNED1', hostname: 'Owned', online: true, tags: 'Allowed' },
            { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Private' }
        ]);
        serverBackend.getAllDevices.mockResolvedValue([
            { id: 'OWNED1', hostname: 'Owned', online: true, tags: 'Allowed' },
            { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Private' }
        ]);
        db.getAllFolderAssignments.mockResolvedValue({});
        db.getAllFolders.mockResolvedValue([]);
        db.getAllPeerSysinfo.mockResolvedValue([]);
        db.getAddressBookTags.mockResolvedValue([]);
        db.saveAddressBook.mockResolvedValue(undefined);
        db.getAllDeviceGroups.mockResolvedValue([]);
        db.getDeviceGroupByGuid.mockResolvedValue(null);
        db.getDeviceGroupMembers.mockResolvedValue([]);
        db.getAddressBook.mockImplementation(async (_userId, abType) => {
            if (abType === 'legacy') {
                return { data: JSON.stringify({ peers: [{ id: 'OWNED1' }] }) };
            }
            return null;
        });
    });

    describe('GET /api/peers', () => {
        it('allows view-only users to browse reachable inventory without address book membership', async () => {
            const res = await request(app)
                .get('/api/peers?include_offline=true')
                .set('Authorization', 'Bearer viewer-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(2);
            expect(res.body.data.map(peer => peer.id)).toEqual(['OWNED1', 'OTHER1']);
            expect(db.getAddressBook).not.toHaveBeenCalled();
        });

        it('returns an empty list for users without device inventory permissions', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 4, username: 'pro1', role: 'pro' });

            const res = await request(app)
                .get('/api/peers?include_offline=true')
                .set('Authorization', 'Bearer pro-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(0);
            expect(res.body.data).toEqual([]);
        });

        it('keeps editable operator inventory synchronization unchanged', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });

            const res = await request(app)
                .get('/api/peers?include_offline=true')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(2);
            expect(res.body.data.map(peer => peer.id)).toEqual(['OWNED1', 'OTHER1']);
            expect(db.getAddressBook).not.toHaveBeenCalled();
        });

        it('exposes reachable and offline devices with correct online flags', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'ONLINE1', hostname: 'Online', online: true, tags: 'Allowed' },
                { id: 'OFFLINE1', hostname: 'Offline', online: false, tags: 'Allowed' }
            ]);

            const res = await request(app)
                .get('/api/peers?include_offline=true')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(2);
            const byId = Object.fromEntries(res.body.data.map(peer => [peer.id, peer]));
            expect(byId.ONLINE1.online).toBe(true);
            expect(byId.OFFLINE1.online).toBe(false);
        });

        it('keeps degraded and critical peers in the reachable devices list', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'DEG1', hostname: 'Degraded', online: false, status_tier: 'degraded', tags: 'Allowed' },
                { id: 'CRIT1', hostname: 'Critical', online: false, live_status: 'critical', tags: 'Allowed' },
                { id: 'OFF1', hostname: 'Offline', online: false, status_tier: 'offline', tags: 'Allowed' }
            ]);

            const res = await request(app)
                .get('/api/peers')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(3);
            const byId = Object.fromEntries(res.body.data.map(peer => [peer.id, peer]));
            expect(byId.DEG1.online).toBe(true);
            expect(byId.CRIT1.online).toBe(true);
            expect(byId.OFF1.online).toBe(false);
        });

        it('mirrors address-book peer fields for RustDesk available devices', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                {
                    id: 'PEER1',
                    hostname: 'server-a',
                    username: 'alice',
                    platform: 'Windows',
                    display_name: 'Finance PC',
                    device_type: 'desktop',
                    online: true,
                    tags: ['Allowed']
                }
            ]);

            const res = await request(app)
                .get('/api/peers')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.data[0]).toMatchObject({
                id: 'PEER1',
                info: {
                    device_name: 'server-a',
                    os: 'Windows',
                    username: 'alice'
                },
                user: 'alice',
                user_name: 'alice',
                alias: 'Finance PC',
                online: true,
                status: 1
            });
        });

        it('filters reachable devices by folder device group guid', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'FOLDER1', hostname: 'Folder device', online: true, tags: 'Allowed' },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Allowed' }
            ]);
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);
            db.getAllFolderAssignments.mockResolvedValue({ FOLDER1: 7 });

            const res = await request(app)
                .get('/api/peers?device_group_guid=folder_7')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.data[0]).toMatchObject({
                id: 'FOLDER1',
                device_group_name: 'Servers'
            });
            expect(serverBackend.getAllDevices).toHaveBeenCalledWith(expect.objectContaining({ search: '' }));
        });

        it('filters reachable devices by folder name', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'FOLDER1', hostname: 'Folder device', online: true, tags: 'Allowed' },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Allowed' }
            ]);
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);
            db.getAllFolderAssignments.mockResolvedValue({ FOLDER1: 7 });

            const res = await request(app)
                .get('/api/peers?group_name=Servers')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.data[0]).toMatchObject({
                id: 'FOLDER1',
                device_group_name: 'Servers'
            });
        });

        it('sets device_group_name from manual device group membership', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'GROUP1', hostname: 'Server A', online: true, tags: 'Allowed' },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Allowed' }
            ]);
            db.getAllDeviceGroups.mockResolvedValue([
                {
                    id: 9,
                    guid: 'dg-servers',
                    name: 'Servers',
                    source_type: 'manual',
                    allowed_users: ['operator1'],
                    allowed_groups: []
                }
            ]);
            db.getDeviceGroupMembers.mockResolvedValue(['GROUP1']);

            const res = await request(app)
                .get('/api/peers?accessible=&status=1')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.data.find(peer => peer.id === 'GROUP1')).toMatchObject({
                device_group_name: 'Servers'
            });
            expect(res.body.data.find(peer => peer.id === 'OTHER1')).toMatchObject({
                device_group_name: ''
            });
        });

        it('supports the RustDesk peers/list envelope with body-based folder filters', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'FOLDER1', hostname: 'Folder device', online: true, tags: 'Allowed' },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: 'Allowed' }
            ]);
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);
            db.getAllFolderAssignments.mockResolvedValue({ FOLDER1: 7 });

            const res = await request(app)
                .post('/api/peers/list')
                .set('Authorization', 'Bearer operator-token')
                .send({ device_group: { guid: 'folder_7' } });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ total: 1, msg: 'success' });
            expect(res.body.data.map(peer => peer.id)).toEqual(['FOLDER1']);
        });

        it('filters reachable devices by tag query parameters', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'TAG1', hostname: 'Tagged', online: true, tags: ['KUZZEL', 'Servers'] },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: ['Servers'] }
            ]);

            const res = await request(app)
                .get('/api/peers?tag=KUZZEL')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.data.map(peer => peer.id)).toEqual(['TAG1']);
        });

        it('falls back to tag matching when a requested group name has no saved group record', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'TAG1', hostname: 'Tagged', online: true, tags: ['KUZZEL'] },
                { id: 'OTHER1', hostname: 'Other', online: true, tags: ['Other'] }
            ]);
            db.getDeviceGroupByGuid.mockResolvedValue(null);
            db.getAllDeviceGroups.mockResolvedValue([]);

            const res = await request(app)
                .get('/api/peers?group=KUZZEL')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.data.map(peer => peer.id)).toEqual(['TAG1']);
        });
    });

    describe('GET /api/ab', () => {
        it('does not auto-add console inventory to editable user address books', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            db.getAddressBook.mockImplementation(async (_userId, abType) => {
                if (abType === 'legacy') {
                    return {
                        data: JSON.stringify({
                            peers: [{ id: 'OWNED1', tags: ['Client'] }],
                            tags: ['Client']
                        })
                    };
                }
                return null;
            });

            const res = await request(app)
                .get('/api/ab')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            const data = JSON.parse(res.body.data);
            expect(data.peers.map(peer => peer.id)).toEqual(['OWNED1']);
            expect(data.peers[0].tags).toEqual(['Client', 'Allowed']);
            expect(data.tags).toEqual(['Client', 'Allowed']);
            expect(serverBackend.getAllDevices).toHaveBeenCalled();
        });

        it('keeps an empty address book empty even when console devices exist', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 1, username: 'admin', role: 'admin' });
            db.getAddressBook.mockResolvedValue({ data: JSON.stringify({ peers: [], tags: [] }) });

            const res = await request(app)
                .get('/api/ab')
                .set('Authorization', 'Bearer admin-token');

            expect(res.status).toBe(200);
            const data = JSON.parse(res.body.data);
            expect(data.peers).toEqual([]);
            expect(data.tags).toEqual([]);
        });
    });

    describe('GET /api/ab/tags', () => {
        it('keeps address book tags when they match console folder names', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);
            db.getAddressBookTags.mockResolvedValue(['Servers', 'Clients']);
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'OWNED1', hostname: 'Owned', online: true, tags: ['Servers'] }
            ]);

            const res = await request(app)
                .get('/api/ab/tags')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.data).toEqual(['Clients', 'Servers']);
        });
    });

    describe('GET /api/device-group', () => {
        it('exposes BetterDesk folders as RustDesk-compatible device groups with stable ids', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'FOLDER1', hostname: 'Folder device', online: true, tags: 'Allowed' }
            ]);
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);
            db.getAllFolderAssignments.mockResolvedValue({ FOLDER1: 7 });
            db.getDeviceGroupByGuid.mockResolvedValue({
                guid: 'folder_7',
                name: 'Servers',
                allowed_users: ['operator1'],
                allowed_groups: []
            });

            const res = await request(app)
                .get('/api/device-group')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.msg).toBe('success');
            expect(res.body.data[0]).toMatchObject({
                guid: 'folder_7',
                name: 'Servers',
                access_perm: 1,
                team: { peers: [{ id: 'FOLDER1' }] }
            });
        });

        it('serves the legacy RustDesk group aliases with the same payload', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            db.getAllDeviceGroups.mockResolvedValue([
                {
                    guid: 'kuzzel',
                    name: 'KUZZEL',
                    source_type: 'tag',
                    tag_filter: 'KUZZEL',
                    allowed_users: ['operator1'],
                    allowed_groups: []
                }
            ]);
            serverBackend.getAllDevices.mockResolvedValue([
                { id: 'TAG1', hostname: 'Tagged', online: true, tags: ['KUZZEL'] }
            ]);

            const res = await request(app)
                .get('/api/group/get')
                .set('Authorization', 'Bearer operator-token');

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.data[0]).toMatchObject({
                guid: 'kuzzel',
                name: 'KUZZEL',
                access_perm: 1,
                team: { peers: [{ id: 'TAG1' }] }
            });
        });
    });

    describe('POST /api/ab', () => {
        it('syncs client-side peer tag changes back to the console even when they match folder names', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 3, username: 'operator1', role: 'operator' });
            db.getAllFolders.mockResolvedValue([{ id: 7, name: 'Servers' }]);

            const res = await request(app)
                .post('/api/ab')
                .set('Authorization', 'Bearer operator-token')
                .send({
                    data: JSON.stringify({
                        peers: [{ id: 'OWNED1', tags: ['ClientTag', 'Servers'] }],
                        tags: ['ClientTag', 'Servers']
                    })
                });

            expect(res.status).toBe(200);
            expect(db.saveAddressBook).toHaveBeenCalled();
            expect(serverBackend.setPeerTags).toHaveBeenCalledWith('OWNED1', ['ClientTag', 'Servers']);
        });
    });

    describe('POST /api/ab/personal', () => {
        it('returns 404 for RustDesk 1.4.7 legacy-mode probe (empty body)', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 1, username: 'admin', role: 'admin' });

            const res = await request(app)
                .post('/api/ab/personal')
                .set('Authorization', 'Bearer admin-token')
                .send({});

            expect(res.status).toBe(404);
            expect(db.saveAddressBook).not.toHaveBeenCalled();
        });

        it('saves personal AB when data is provided', async () => {
            authService.validateAccessToken.mockResolvedValue({ id: 1, username: 'admin', role: 'admin' });

            const res = await request(app)
                .post('/api/ab/personal')
                .set('Authorization', 'Bearer admin-token')
                .send({ data: JSON.stringify({ peers: [], tags: [] }) });

            expect(res.status).toBe(200);
            expect(db.saveAddressBook).toHaveBeenCalled();
        });
    });

    describe('panel route fallthrough (session cookie, no Bearer)', () => {
        it('GET /api/devices falls through to panel routes', async () => {
            const panelApp = createTestApp();
            panelApp.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            const devicesRoutes = require('../routes/devices.routes');
            panelApp.use('/', rustdeskApiRoutes);
            panelApp.use('/', devicesRoutes);
            serverBackend.getAllDevices.mockResolvedValue([
                { id: '123456789', hostname: 'PC-1', last_online: '2026-03-26T12:00:00Z' }
            ]);

            const res = await request(panelApp).get('/api/devices');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.devices).toHaveLength(1);
        });

        it('GET /api/devices without Bearer falls through when no panel router is mounted', async () => {
            const res = await request(app).get('/api/devices');
            expect(res.status).toBe(404);
        });

        it('GET /api/devices with Bearer uses rustdesk handler', async () => {
            db.getAllDevices.mockResolvedValue([{ id: 'abc123', guid: 'g1' }]);
            const res = await request(app)
                .get('/api/devices')
                .set('Authorization', 'Bearer viewer-token');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('GET /api/strategies without panel handler returns 404 after fallthrough', async () => {
            const panelApp = createTestApp();
            panelApp.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            const devicesRoutes = require('../routes/devices.routes');
            panelApp.use('/', rustdeskApiRoutes);
            panelApp.use('/', devicesRoutes);
            db.getAllStrategies = jest.fn().mockResolvedValue([
                { guid: 's1', name: 'Default', enabled: 1, permissions: {} }
            ]);

            const res = await request(panelApp).get('/api/strategies');

            expect(res.status).toBe(404);
        });
    });
});