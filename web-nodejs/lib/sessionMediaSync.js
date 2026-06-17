'use strict';

/**
 * Scope keyboard/mouse capture, inbound clipboard, and audio to the active
 * streaming tab. Used by remote.js and unit tests.
 *
 * @param {Map<string, { deviceId: string, state: string, client?: { setSessionActive?: Function } }>} sessions
 * @param {string|null} activeSessionId
 */
function syncSessionMediaCapture(sessions, activeSessionId) {
    for (const session of sessions.values()) {
        if (!session.client || typeof session.client.setSessionActive !== 'function') continue;
        const active = session.deviceId === activeSessionId && session.state === 'streaming';
        session.client.setSessionActive(active);
    }
}

module.exports = { syncSessionMediaCapture };
