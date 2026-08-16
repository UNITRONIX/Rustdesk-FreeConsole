const deviceGroupService = require('../services/deviceGroupService');

describe('deviceGroupService scope (#227)', () => {
    const devices = [
        { id: '100', folder_id: 1 },
        { id: '200', folder_id: 2 },
        { id: '300', folder_id: null }
    ];

    beforeEach(() => {
        deviceGroupService.invalidateDeviceScopeDefaultCache();
    });

    test('open setting returns null when no ACL or grants', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('open'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator' };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).toBeNull();
    });

    test('restricted default denies all when no ACL or grants', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('restricted'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator' };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.size).toBe(0);
    });

    test('empty ACL group denies non-admins and hides member devices', async () => {
        const emptyGroup = {
            guid: 'folder_1',
            folder_id: 1,
            allowed_users: [],
            allowed_groups: [],
            source_type: 'manual'
        };
        const db = {
            getSetting: jest.fn().mockResolvedValue('open'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([emptyGroup]),
            getUserGroupsForUser: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator', user_groups: [] };
        expect(deviceGroupService.groupAllowedForUser(emptyGroup, user)).toBe(false);
        expect(deviceGroupService.groupAllowedForUser(emptyGroup, { ...user, role: 'admin' })).toBe(true);
        expect(deviceGroupService.groupAllowedForUser(emptyGroup, { ...user, role: 'admin' }, { strict: true })).toBe(false);

        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.has('100')).toBe(false);
        expect(scope.has('200')).toBe(true);
        expect(scope.has('300')).toBe(true);
    });

    test('strict ACL for RustDesk AB hides admin groups outside their user group', () => {
        const eventGroup = {
            guid: 'dg-event',
            name: 'Event Servers',
            allowed_users: [],
            allowed_groups: ['ug-other'],
            source_type: 'manual'
        };
        const dcsGroup = {
            guid: 'dg-dcs',
            name: 'DCS Servers',
            allowed_users: [],
            allowed_groups: ['ug-ops'],
            source_type: 'manual'
        };
        const admin = { id: 1, username: 'Chesster', role: 'admin', user_groups: ['ug-ops'] };
        expect(deviceGroupService.groupAllowedForUser(eventGroup, admin)).toBe(true);
        expect(deviceGroupService.groupAllowedForUser(eventGroup, admin, { strict: true })).toBe(false);
        expect(deviceGroupService.groupAllowedForUser(dcsGroup, admin, { strict: true })).toBe(true);
    });

    test('explicit grants switch to allowlist-only (no unassigned overlay)', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('open'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([
                {
                    guid: 'folder_1',
                    folder_id: 1,
                    allowed_users: ['op1'],
                    allowed_groups: [],
                    source_type: 'manual'
                },
                {
                    guid: 'folder_2',
                    folder_id: 2,
                    allowed_users: ['other'],
                    allowed_groups: [],
                    source_type: 'manual'
                }
            ]),
            getUserGroupsForUser: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator', user_groups: [] };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.has('100')).toBe(true);
        expect(scope.has('200')).toBe(false);
        expect(scope.has('300')).toBe(false);
    });

    test('direct peer grants are allowlist-only in open mode', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('open'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([
                {
                    guid: 'folder_1',
                    folder_id: 1,
                    allowed_users: ['other'],
                    allowed_groups: [],
                    source_type: 'manual'
                }
            ]),
            getUserGroupsForUser: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue(['300'])
        };
        const user = { id: 5, username: 'op1', role: 'operator', user_groups: [] };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.has('300')).toBe(true);
        expect(scope.has('100')).toBe(false);
        expect(scope.has('200')).toBe(false);
    });

    test('missing getAllDeviceGroups denies non-admins (never null)', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('restricted')
        };
        const user = { id: 5, username: 'op1', role: 'operator' };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.size).toBe(0);
    });

    test('missing user.id denies non-admins (never null)', async () => {
        const db = {
            getSetting: jest.fn().mockResolvedValue('open'),
            getAllDeviceGroups: jest.fn().mockResolvedValue([])
        };
        const user = { username: 'op1', role: 'operator' };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.size).toBe(0);
    });
});
