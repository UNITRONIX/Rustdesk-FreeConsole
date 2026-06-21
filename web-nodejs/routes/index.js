/**
 * BetterDesk Console - Routes Index
 * Mounts all route modules
 */

const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const devicesRoutes = require('./devices.routes');
const keysRoutes = require('./keys.routes');
const settingsRoutes = require('./settings.routes');
const generatorRoutes = require('./generator.routes');
const i18nRoutes = require('./i18n.routes');
const usersRoutes = require('./users.routes');
const foldersRoutes = require('./folders.routes');
const remoteRoutes = require('./remote.routes');
// bdApiRoutes mounted in server.js (before CSRF) for desktop client access
const pagesRoutes = require('./pages.routes');
const desktopRoutes = require('./desktop.routes');
const registrationRoutes = require('./registration.routes');

/**
 * Lazy-load wrapper — defers require() until first request.
 * Reduces startup time by ~200-400ms for rarely-used modules.
 */
function lazyRoute(modulePath) {
    let _router;
    return function (req, res, next) {
        if (!_router) _router = require(modulePath);
        _router(req, res, next);
    };
}

// Lazy-loaded route modules (loaded on first request)
const inventoryRoutes = lazyRoute('./inventory.routes');
const ticketsRoutes = lazyRoute('./tickets.routes');
const activityRoutes = lazyRoute('./activity.routes');
const automationRoutes = lazyRoute('./automation.routes');
const fileTransferRoutes = lazyRoute('./fileTransfer.routes');
const networkRoutes = lazyRoute('./network.routes');
const dataguardRoutes = lazyRoute('./dataguard.routes');
const reportsRoutes = lazyRoute('./reports.routes');
const tenantsRoutes = lazyRoute('./tenants.routes');
const cdapRoutes = lazyRoute('./cdap.routes');
const chatRoutes = require('./chat.routes');
const tokensRoutes = lazyRoute('./tokens.routes');
const organizationsRoutes = lazyRoute('./organizations.routes');
const policiesRoutes = lazyRoute('./policies.routes');
const fleetRoutes = lazyRoute('./fleet.routes');
const commercializationRoutes = lazyRoute('./commercialization.routes');
const scalingRoutes = lazyRoute('./scaling.routes');
const crossPlatformRoutes = lazyRoute('./cross-platform.routes');
const toolkitRoutes = lazyRoute('./toolkit.routes');
const securityAuditRoutes = lazyRoute('./security-audit.routes');
const languagesRoutes = lazyRoute('./languages.routes');
const resourceControlRoutes = lazyRoute('./resource-control.routes');
const systemRoutes = lazyRoute('./system.routes');
const cdapStudioRoutes = lazyRoute('./cdap-studio.routes');
const permissionsRoutes = lazyRoute('./permissions.routes');
const phase45Routes = lazyRoute('./phase4_5.routes');
const serverManagementRoutes = lazyRoute('./server-management.routes');
const serverAttestationRoutes = lazyRoute('./server-attestation.routes');

/**
 * Middleware to require JSON Content-Type for POST/PATCH/PUT requests to API routes.
 * This provides an additional layer of CSRF protection.
 */
function requireJsonContentType(req, res, next) {
    // Skip for GET, DELETE, OPTIONS, HEAD
    if (['GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
        return next();
    }
    // Skip for non-API routes (form submissions, file uploads)
    if (!req.path.startsWith('/api/')) {
        return next();
    }
    // Skip for specific routes that accept form data (file uploads)
    if (req.path.includes('/upload') || req.path.includes('/import')) {
        return next();
    }
    // Check Content-Type
    if (!req.is('application/json')) {
        return res.status(415).json({ 
            success: false, 
            error: 'Content-Type must be application/json' 
        });
    }
    next();
}

// Apply JSON content type check middleware
router.use(requireJsonContentType);

// Health check (no auth required)
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount routes
router.use('/', authRoutes);
router.use('/', dashboardRoutes);
router.use('/', devicesRoutes);
router.use('/', keysRoutes);
router.use('/', settingsRoutes);
router.use('/', generatorRoutes);
router.use('/', usersRoutes);
router.use('/', foldersRoutes);
router.use('/', remoteRoutes);
router.use('/api/i18n', i18nRoutes);
// bdApiRoutes now mounted in server.js (before CSRF) for desktop client access
router.use('/api/bd', inventoryRoutes);     // device-facing: /api/bd/inventory, /api/bd/telemetry
router.use('/api/inventory', inventoryRoutes); // admin-facing: /api/inventory, /api/inventory/:id
router.use('/api/tickets', ticketsRoutes);      // admin-facing: /api/tickets CRUD
router.use('/api/tickets', ticketsRoutes);      // device-facing: /api/tickets/bd (agent creates tickets)
router.use('/api/bd', activityRoutes);           // device-facing: /api/bd/activity
router.use('/api/activity', activityRoutes);     // admin-facing: /api/activity
router.use('/api/automation', automationRoutes); // admin-facing: /api/automation/*
router.use('/api/bd', automationRoutes);         // device-facing: /api/bd/commands
router.use('/api/files', fileTransferRoutes);    // admin-facing: /api/files/transfer(s)
router.use('/api/bd', fileTransferRoutes);       // device-facing: /api/bd/file-transfer
router.use('/api/network', networkRoutes);       // admin-facing: /api/network/*
router.use('/api/dataguard', dataguardRoutes);   // admin-facing: /api/dataguard/*
router.use('/api/bd', dataguardRoutes);          // device-facing: /api/bd/dlp-policies, /api/bd/dlp-events
router.use('/api/reports', reportsRoutes);       // admin-facing: /api/reports/*
router.use('/api/tenants', tenantsRoutes);       // admin-facing: /api/tenants/*
router.use('/', registrationRoutes);               // admin-facing: /registrations, /api/registrations/*
router.use('/api/bd', registrationRoutes);          // device-facing: /api/bd/register-request, /api/bd/register-status
router.use('/', pagesRoutes);                          // page routes: /inventory, /tickets, /automation, etc.
router.use('/', cdapRoutes);                            // admin-facing: /cdap/devices/:id, /api/cdap/*
router.use('/', lazyRoute('./meshcentral.routes'));     // MeshCentral compat API + settings
router.use('/', chatRoutes);                             // admin-facing: /chat, /api/chat/*
router.use('/', tokensRoutes);                          // admin-facing: /tokens, /api/panel/tokens/*
router.use('/api/desktop', desktopRoutes);               // admin-facing: /api/desktop/layout, /api/desktop/wallpapers
router.use('/', organizationsRoutes);                    // admin-facing: /organizations, /api/panel/org/*
router.use('/', policiesRoutes);                         // admin-facing: /policies, /api/panel/policies/*, /api/bd/device-policy, /api/bd/attestation
router.use('/api/bd', policiesRoutes);                   // device-facing: /api/bd/device-policy, /api/bd/attestation
router.use('/', fleetRoutes);                            // admin-facing: /fleet, /api/panel/fleet/*
router.use('/', commercializationRoutes);                // admin-facing: /commercialization, /api/panel/billing/*
router.use('/api/bd', fleetRoutes);                      // device-facing: /api/bd/fleet/task-result, /api/bd/fleet/software
router.use('/', scalingRoutes);                          // admin-facing: /scaling, /api/panel/scaling/*
router.use('/api/bd', scalingRoutes);                    // device-facing: /api/bd/scaling/relay-heartbeat
router.use('/', crossPlatformRoutes);                    // admin-facing: /cross-platform, /api/panel/cross-platform/*
router.use('/', toolkitRoutes);                              // admin-facing: /toolkit, /api/toolkit/*
router.use('/', securityAuditRoutes);                        // admin-facing: /security-audit, /api/panel/security-audit/*
router.use('/', languagesRoutes);                            // admin-facing: /languages, /api/panel/languages/*
router.use('/', resourceControlRoutes);                      // admin-facing: /resource-control, /api/panel/resource-control/*
router.use('/api/bd', resourceControlRoutes);                 // device-facing: /api/bd/resource-policy
router.use('/', systemRoutes);                           // admin-facing: /api/system/*, /api/logs/*, /api/database/*, /api/docker/*, /api/speed-test
router.use('/', cdapStudioRoutes);                       // admin-facing: /cdap-studio, /api/cdap-studio/*
router.use('/', permissionsRoutes);                      // admin-facing: /permissions, /api/panel/roles/*, /api/panel/role-permissions/*
router.use('/', serverManagementRoutes);                 // admin-facing: /server-management, /api/server-management/* (BETA)
router.use('/', serverAttestationRoutes);                // admin-facing: /server-attestation, /api/server-attestation/*
router.use('/', phase45Routes);                          // Phase 4/5: /api/users/me/profile, /api/agent-templates, /portal

module.exports = router;
