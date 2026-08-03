const deviceGroupService = require('../services/deviceGroupService');

describe('deviceGroupService scope (#227)', () => {
    const devices = [
        { id: '100', folder_id: 1 },
        { id: '200', folder_id: 2 },
        { id: '300', folder_id: null }
    ];

    test('open default returns null when no ACL or grants', async () => {
        const db = {
            getAllDeviceGroups: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator' };
        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).toBeNull();
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
            getAllDeviceGroups: jest.fn().mockResolvedValue([emptyGroup]),
            getUserGroupsForUser: jest.fn().mockResolvedValue([]),
            getUserPeerGrants: jest.fn().mockResolvedValue([])
        };
        const user = { id: 5, username: 'op1', role: 'operator', user_groups: [] };
        expect(deviceGroupService.groupAllowedForUser(emptyGroup, user)).toBe(false);
        expect(deviceGroupService.groupAllowedForUser(emptyGroup, { ...user, role: 'admin' })).toBe(true);

        const scope = await deviceGroupService.getDeviceScopeForUser(db, user, devices);
        expect(scope).not.toBeNull();
        expect(scope.has('100')).toBe(false);
        expect(scope.has('200')).toBe(true);
        expect(scope.has('300')).toBe(true);
    });

    test('direct peer grants are always visible in open overlay mode', async () => {
        const db = {
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
    });
});
