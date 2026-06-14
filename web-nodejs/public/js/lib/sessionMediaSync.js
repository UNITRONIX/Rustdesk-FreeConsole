/**
 * Multi-session viewer: gate input/clipboard/audio to the active tab.
 * Shared with web-nodejs/lib/sessionMediaSync.js (keep in sync).
 */
(function (global) {
    'use strict';

    function syncSessionMediaCapture(sessions, activeSessionId) {
        for (const session of sessions.values()) {
            if (!session.client || typeof session.client.setSessionActive !== 'function') continue;
            const active = session.deviceId === activeSessionId && session.state === 'streaming';
            session.client.setSessionActive(active);
        }
    }

    global.syncSessionMediaCapture = syncSessionMediaCapture;
})(typeof window !== 'undefined' ? window : globalThis);
