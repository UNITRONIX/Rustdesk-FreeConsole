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
