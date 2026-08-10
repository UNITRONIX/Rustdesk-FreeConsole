'use strict';

const fs = require('fs');
const path = require('path');

describe('Live device identity and CSV download UI', () => {
    test('renders the controller Remote PC ID beside the active user', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/js/devices.js'),
            'utf8'
        );
        expect(source).toContain('active_remote_sessions');
        expect(source).toContain('session.controller_id');
        expect(source).toContain('remote-live-id');
    });

    test('uses a direct authenticated CSV response instead of a Blob download', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/js/deviceActivity.js'),
            'utf8'
        );
        expect(source).toContain("link.href = `/api/devices/activity/export?");
        expect(source).toContain("link.target = '_blank'");
        expect(source).not.toContain('URL.createObjectURL');
        expect(source).not.toContain('response.blob()');
    });

    test('allows downloads from Devices opened in a desktop window iframe', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/js/desktop-mode.js'),
            'utf8'
        );
        expect(source).toContain('allow-downloads allow-popups-to-escape-sandbox');
    });

    test('renders filtered connected time separately from the ticking current session', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/js/deviceActivity.js'),
            'utf8'
        );
        expect(source).toContain('operator.connected_seconds');
        expect(source).toContain('operator.current_session_seconds');
        expect(source).toContain('operator.current_session_started_at');
        expect(source).toContain('updateCurrentSessionDurations');
        expect(source).toContain('session.started_at');
        expect(source).toContain('session.ended_at');
        expect(source).toContain('session.controller_id');
        expect(source).toContain('device.peer_id');
    });

    test('uses distinct high-contrast colours for totals, current sessions and evidence', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../public/css/device-activity.css'),
            'utf8'
        );
        expect(source).toContain('border-top: 3px solid var(--accent-blue');
        expect(source).toContain('.device-activity-current-session');
        expect(source).toContain('var(--accent-green');
        expect(source).toContain('.activity-session-evidence');
        expect(source).toContain('#device-activity-close');
    });
});
