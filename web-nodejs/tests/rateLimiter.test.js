/**
 * Panel poll rate-limit classification tests
 */

const { isPanelPollRequest, PANEL_POLL_PATHS } = require('../middleware/rateLimiter');

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

    it('does not classify unrelated API paths as panel poll', () => {
        expect(isPanelPollRequest({ method: 'GET', path: '/api/settings/info' })).toBe(false);
    });
});
