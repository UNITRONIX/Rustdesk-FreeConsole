'use strict';

const {
    resolveOperatorUsernamesForDevice,
    resolveOperatorEmailsForDevice,
} = require('../services/deviceGroupService');

describe('deviceGroupService email routing', () => {
    it('resolves usernames from folder mirror group ACL', async () => {
        const db = {
            getAllFolderAssignments: jest.fn().mockResolvedValue([
                { device_id: 'dev-1', folder_id: 3 },
            ]),
            getDeviceGroupByGuid: jest.fn().mockResolvedValue({
                guid: 'folder_3',
                allowed_users: ['alice', 'bob'],
                allowed_groups: [],
            }),
            getAllDeviceGroups: jest.fn().mockResolvedValue([]),
        };

        const usernames = await resolveOperatorUsernamesForDevice(db, 'dev-1');
        expect(usernames.sort()).toEqual(['alice', 'bob']);
    });

    it('maps usernames to configured emails', async () => {
        const db = {
            getAllFolderAssignments: jest.fn().mockResolvedValue([
                { device_id: 'dev-2', folder_id: 1 },
            ]),
            getDeviceGroupByGuid: jest.fn().mockResolvedValue({
                guid: 'folder_1',
                allowed_users: ['alice', 'bob'],
                allowed_groups: [],
            }),
            getAllDeviceGroups: jest.fn().mockResolvedValue([]),
            getUsersEmailsByUsernames: jest.fn().mockResolvedValue([
                { username: 'alice', email: 'alice@example.com' },
                { username: 'bob', email: '' },
            ]),
        };

        const emails = await resolveOperatorEmailsForDevice(db, 'dev-2');
        expect(emails).toEqual([{ username: 'alice', email: 'alice@example.com' }]);
    });

    it('returns empty list when device has no restricted ACL', async () => {
        const db = {
            getAllFolderAssignments: jest.fn().mockResolvedValue([]),
            getAllDeviceGroups: jest.fn().mockResolvedValue([
                { guid: 'grp-1', allowed_users: [], allowed_groups: [] },
            ]),
            getAllPeers: jest.fn().mockResolvedValue([{ id: 'dev-3' }]),
            getDeviceGroupMembers: jest.fn().mockResolvedValue(['dev-3']),
        };

        const usernames = await resolveOperatorUsernamesForDevice(db, 'dev-3');
        expect(usernames).toEqual([]);
    });
});
