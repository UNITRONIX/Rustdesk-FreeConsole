'use strict';

const {
    enrollmentToNotification,
    lanRegistrationToNotification,
    listRegistrationNotifications,
} = require('../services/registrationNotifications');

describe('registration notification view model', () => {
    it('uses stable source-specific IDs and registration links', () => {
        expect(lanRegistrationToNotification({
            id: 12,
            device_id: 'LAN-12',
            hostname: 'Office PC',
            created_at: '2026-08-23T12:00:00.000Z',
        })).toMatchObject({
            id: 'registration:lan:12',
            kind: 'registration',
            source: 'lan',
            link: '/registrations',
            status: 'pending',
        });

        expect(enrollmentToNotification({
            device_id: 'GO-12',
            hostname: 'Managed PC',
            created_at: '2026-08-23T12:01:00.000Z',
        })).toMatchObject({
            id: 'registration:enrollment:GO-12',
            kind: 'registration',
            source: 'enrollment',
            link: '/registrations',
            status: 'pending',
        });
    });

    it('combines both stores and tolerates one unavailable source', async () => {
        const result = await listRegistrationNotifications(
            {
                getPendingRegistrations: jest.fn().mockResolvedValue([{
                    id: 1,
                    device_id: 'LAN-1',
                    created_at: '2026-08-23T12:00:00.000Z',
                }]),
            },
            {
                getEnrollmentPending: jest.fn().mockRejectedValue(new Error('Go offline')),
            },
        );

        expect(result.count).toBe(1);
        expect(result.items[0].id).toBe('registration:lan:1');
    });
});
