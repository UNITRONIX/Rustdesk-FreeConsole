'use strict';

/**
 * Shared view model for pending registration notifications.
 *
 * LAN registrations are stored in the console database while managed
 * enrollments are stored by the Go server. Keeping their normalization here
 * prevents the sidebar count and navbar notification center from drifting.
 */

function toCreatedAt(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function registrationMessage(deviceId, platform, ip) {
    return [deviceId, platform, ip].filter(Boolean).join(' · ');
}

function lanRegistrationToNotification(registration) {
    if (!registration || registration.id === undefined || registration.id === null) return null;
    const deviceId = String(registration.device_id || '');
    return {
        id: `registration:lan:${registration.id}`,
        title: registration.hostname || deviceId,
        message: registrationMessage(deviceId, registration.platform, registration.ip_address),
        icon: 'how_to_reg',
        link: '/registrations',
        read: false,
        created_at: toCreatedAt(registration.created_at || registration.updated_at),
        kind: 'registration',
        source: 'lan',
        device_id: deviceId,
        status: 'pending',
    };
}

function enrollmentToNotification(enrollment) {
    if (!enrollment || !enrollment.device_id) return null;
    const deviceId = String(enrollment.device_id);
    return {
        id: `registration:enrollment:${deviceId}`,
        title: enrollment.hostname || deviceId,
        message: registrationMessage(deviceId, enrollment.platform, enrollment.ip),
        icon: 'how_to_reg',
        link: '/registrations',
        read: false,
        created_at: toCreatedAt(enrollment.created_at),
        kind: 'registration',
        source: 'enrollment',
        device_id: deviceId,
        status: 'pending',
    };
}

/**
 * Load pending requests from both registration stores.
 *
 * A failed source is treated as empty so one unavailable backend does not
 * hide notifications from the other source.
 */
async function listRegistrationNotifications(db, betterdeskApi) {
    const [lanResult, enrollmentResult] = await Promise.all([
        typeof db?.getPendingRegistrations === 'function'
            ? Promise.resolve(db.getPendingRegistrations({ status: 'pending' })).catch(() => [])
            : Promise.resolve([]),
        typeof betterdeskApi?.getEnrollmentPending === 'function'
            ? Promise.resolve(betterdeskApi.getEnrollmentPending()).catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] }),
    ]);

    const lanItems = (Array.isArray(lanResult) ? lanResult : [])
        .map(lanRegistrationToNotification)
        .filter(Boolean);
    const enrollmentItems = (Array.isArray(enrollmentResult?.data) ? enrollmentResult.data : [])
        .map(enrollmentToNotification)
        .filter(Boolean);
    const items = [...lanItems, ...enrollmentItems]
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return {
        items,
        count: items.length,
    };
}

module.exports = {
    enrollmentToNotification,
    lanRegistrationToNotification,
    listRegistrationNotifications,
};
