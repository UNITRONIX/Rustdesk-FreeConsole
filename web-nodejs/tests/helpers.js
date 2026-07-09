/**
 * BetterDesk Console - Test Helper
 * Creates a minimal Express app with mocked services for unit testing.
 */

const express = require('express');
const session = require('express-session');
const path = require('path');
const { escapeHtml } = require('../lib/escapeHtml');

/**
 * Create a minimal Express app for testing routes.
 * Mocks session, i18n, CSRF, and template engine.
 */
function createTestApp() {
    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // Session middleware (in-memory for tests)
    app.use(session({
        secret: 'test-secret-key-for-unit-tests',
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false }
    }));

    // Mock i18n - req.t() returns the key
    app.use((req, res, next) => {
        req.t = (key) => key;
        res.locals.escapeHtml = escapeHtml;
        next();
    });

    // EJS view engine (templates not rendered in most API tests)
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));

    return app;
}

/**
 * Helper to set a session on the test agent.
 * Uses a small middleware to inject session values.
 */
function withAuth(app, user = {}) {
    const defaults = {
        id: 1,
        username: 'admin',
        role: 'admin',
        ...user
    };

    app.use((req, _res, next) => {
        if (!req._authApplied) {
            req.session.userId = defaults.id;
            req.session.user = defaults;
            req._authApplied = true;
        }
        next();
    });
}

/**
 * Create a mock database service.
 */
function createMockDb() {
    return {
        logAction: jest.fn().mockResolvedValue(undefined),
        getUser: jest.fn().mockResolvedValue(null),
        getAllUsers: jest.fn().mockResolvedValue([]),
        createUser: jest.fn().mockResolvedValue({ id: 1 }),
        updateUser: jest.fn().mockResolvedValue(undefined),
        deleteUser: jest.fn().mockResolvedValue(undefined),
        getPeerSysinfo: jest.fn().mockResolvedValue(null),
        getLatestPeerMetric: jest.fn().mockResolvedValue(null),
        getPeerMetrics: jest.fn().mockResolvedValue([]),
        getDeviceGroupsForPeer: jest.fn().mockResolvedValue([]),
        getFolders: jest.fn().mockResolvedValue([]),
        createFolder: jest.fn().mockResolvedValue({ id: 1 }),
        updateFolder: jest.fn().mockResolvedValue(undefined),
        deleteFolder: jest.fn().mockResolvedValue(undefined),
        cleanupDeletedPeerData: jest.fn().mockResolvedValue(undefined),
        getAuditLog: jest.fn().mockResolvedValue([])
    };
}

/**
 * Create a mock serverBackend service.
 */
function createMockBackend() {
    return {
        getAllDevices: jest.fn().mockResolvedValue([]),
        getDeviceById: jest.fn().mockResolvedValue(null),
        updateDevice: jest.fn().mockResolvedValue(undefined),
        deleteDevice: jest.fn().mockResolvedValue(undefined),
        getServerStats: jest.fn().mockResolvedValue({
            totalDevices: 0,
            onlineDevices: 0,
            offlineDevices: 0
        })
    };
}

module.exports = {
    createTestApp,
    withAuth,
    createMockDb,
    createMockBackend
};
