'use strict';

const assert = require('assert');

jest.mock('../services/betterdeskApi', () => ({
    getMeshStatus: jest.fn(),
    apiClient: {},
}));

describe('meshcentral.routes', () => {
    it('registers mesh status, recordings, and group routes', () => {
        const router = require('../routes/meshcentral.routes');
        assert.ok(router);
        const paths = (router.stack || []).map((layer) => layer.route && layer.route.path).filter(Boolean);
        assert.ok(paths.includes('/api/mesh/status'));
        assert.ok(paths.includes('/api/session/recordings'));
        assert.ok(paths.includes('/api/mesh/devices/:id/group'));
        assert.ok(paths.includes('/api/mesh/recordings'));
    });
});
