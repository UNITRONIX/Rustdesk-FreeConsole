/**
 * Panel poll rate-limit classification tests
 */

const { isPanelPollRequest, isPanelPreferenceWrite, PANEL_POLL_PATHS } = require('../middleware/rateLimiter');

describe('rateLimiter panel poll paths', () => {
    it('classifies dashboard client-config GET as panel poll', () => {
        expect(isPanelPollRequest({ method: 'GET', path: '/api/dashboard/client-config' })).toBe(true);
    });

    it('does not classify POST mutations as panel poll', () => {
        expect(isPanelPollRequest({ method: 'POST', path: '/api/devices' })).toBe(false);
        expect(isPanelPollRequest({ method: 'POST', path: '/api/dashboard/client-config' })).toBe(false);
    });

    it('includes core widget paths in the poll set', () => {
        expect(PANEL_POLL_PATHS.has('/api/stats')).toBe(true);
        expect(PANEL_POLL_PATHS.has('/api/dashboard/activity')).toBe(true);
    });

    it('includes devices page read paths in the poll set', () => {
        expect(PANEL_POLL_PATHS.has('/api/folders')).toBe(true);
        expect(PANEL_POLL_PATHS.has('/api/tags')).toBe(true);
        expect(PANEL_POLL_PATHS.has('/api/device-groups')).toBe(true);
        expect(PANEL_POLL_PATHS.has('/api/bd/notifications')).toBe(true);
    });

    it('classifies /api/panel/* GET as panel poll via prefix', () => {
        expect(isPanelPollRequest({ method: 'GET', path: '/api/panel/strategies' })).toBe(true);
        expect(isPanelPollRequest({ method: 'GET', path: '/api/panel/user-groups' })).toBe(true);
    });

    it('does not classify unrelated API paths as panel poll', () => {
        expect(isPanelPollRequest({ method: 'GET', path: '/api/settings/info' })).toBe(false);
    });

    it('classifies desktop layout POST as panel preference write', () => {
        expect(isPanelPreferenceWrite({ method: 'POST', path: '/api/desktop/layout' })).toBe(true);
        expect(isPanelPreferenceWrite({ method: 'GET', path: '/api/desktop/layout' })).toBe(false);
        expect(isPanelPreferenceWrite({ method: 'POST', path: '/api/devices' })).toBe(false);
    });
});
