/**
 * BetterDesk Console - Auth Middleware
 * Protects routes that require authentication
 */

// Default role-permission map (mirrors Go auth/permissions.go — Phase 52+)
//
// Role hierarchy (branched, not strictly linear):
//   super_admin  — full server + all-org access
//   ├── server_admin — server config/logs, read-only user visibility
//   ├── global_admin — all-org user/device management, no server access
//   └── admin        — legacy alias for super_admin
//       operator, viewer, pro — unchanged (pro = PRO activation only, no devices)
const DEFAULT_ROLE_PERMISSIONS = {
    super_admin: null, // null = ALL permissions
    admin: null,       // legacy admin = super_admin

    // Server Admin: infrastructure + read-only users
    server_admin: new Set([
        'server.config', 'server.keys',
        'blocklist.edit',
        'user.view',
        'device.view',
        'audit.view', 'metrics.view',
        'enrollment.manage',
    ]),

    // Global Admin: all user/org management, NO server config
    global_admin: new Set([
        'user.view', 'user.create', 'user.edit', 'user.delete',
        'org.create', 'org.edit', 'org.delete', 'org.manage_users', 'org.manage_devices',
        'device.view', 'device.connect', 'device.edit', 'device.delete',
        'device.ban', 'device.change_id',
        'audit.view', 'metrics.view',
        'cdap.view', 'cdap.command',
        'chat.access',
        'enrollment.manage', 'enrollment.approve',
        'branding.edit',
    ]),

    operator: new Set([
        'device.view', 'device.connect', 'device.edit',
        'user.view',
        'audit.view', 'metrics.view',
        'cdap.view', 'cdap.command',
        'enrollment.approve',
        'chat.access',
        'org.manage_devices',
    ]),
    viewer: new Set([
        'device.view',
        'audit.view', 'metrics.view',
        'cdap.view',
        'chat.access',
    ]),
    pro: new Set(),
};

function isProRole(role) {
    return role === 'pro';
}

function proRoleBlocksPermission(role, permission) {
    if (!isProRole(role)) return false;
    return permission.startsWith('device.') || permission === 'org.manage_devices';
}

// Roles that have full admin privileges (bypass all permission checks).
const SUPER_ADMIN_ROLES = new Set(['super_admin', 'admin']);

/**
 * Check if a role is a super admin (or legacy admin).
 */
function isSuperAdminRole(role) {
    return SUPER_ADMIN_ROLES.has(role);
}

/**
 * Check if a role has a specific permission by default.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
function roleHasPermission(role, permission) {
    if (proRoleBlocksPermission(role, permission)) return false;
    if (isSuperAdminRole(role)) return true;
    const perms = DEFAULT_ROLE_PERMISSIONS[role];
    if (!perms) return false;
    return perms.has(permission);
}

/**
 * Require authentication middleware
 * Redirects to login page for HTML requests, returns 401 for API requests
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        // API request
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized. Please log in.'
            });
        }
        
        // HTML request - redirect to login
        return res.redirect('/login');
    }
    
    // Block pro-only users from web panel (API-only role)
    if (req.session.user && req.session.user.role === 'pro') {
        req.session.destroy();
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({
                success: false,
                error: 'Pro accounts can only access the RustDesk desktop client API'
            });
        }
        return res.redirect('/login');
    }
    
    // Add user info to locals for templates
    res.locals.user = req.session.user;
    // Phase A: expose emergency mode flag to EJS templates
    res.locals.emergencyMode = !!req.session.emergencyMode;
    
    next();
}

/**
 * Require specific role
 */
function requireRole(role) {
    return function(req, res, next) {
        if (!req.session || !req.session.userId) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }
        
        const userRole = req.session.user && req.session.user.role;

        // Super admin roles bypass all role checks.
        if (isSuperAdminRole(userRole)) {
            res.locals.user = req.session.user;
            return next();
        }

        if (userRole !== role) {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
            return res.status(403).render('error', { 
                title: 'Forbidden',
                message: 'You do not have permission to access this resource'
            });
        }
        
        res.locals.user = req.session.user;
        next();
    };
}

/**
 * Optional auth - add user to locals if logged in, but don't require it
 */
function optionalAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.user = req.session.user;
    } else {
        res.locals.user = null;
    }
    next();
}

/**
 * Guest only - redirect to dashboard if already logged in
 */
function guestOnly(req, res, next) {
    if (req.session && req.session.userId) {
        return res.redirect('/');
    }
    next();
}

/**
 * Require admin role (super_admin, admin, or global_admin for user management)
 */
function requireAdmin(req, res, next) {
    if (!req.session || !req.session.userId) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    
    const userRole = req.session.user && req.session.user.role;
    if (!isSuperAdminRole(userRole) && userRole !== 'global_admin') {
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        return res.status(403).render('errors/403', { 
            title: 'Forbidden',
            message: 'You do not have permission to access this resource'
        });
    }
    
    res.locals.user = req.session.user;
    next();
}

/**
 * Require a specific granular permission (RBAC Phase 52).
 * Uses the default role-permission map. Admin role always passes.
 * @param {string} permission - e.g. 'device.view', 'user.edit'
 */
function requirePermission(permission) {
    return function(req, res, next) {
        if (!req.session || !req.session.userId) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }

        const role = req.session.user && req.session.user.role;
        if (!roleHasPermission(role, permission)) {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: `Permission denied: ${permission}` });
            }
            return res.status(403).render('errors/403', {
                title: 'Forbidden',
                message: 'You do not have permission to access this resource'
            });
        }

        res.locals.user = req.session.user;
        next();
    };
}

module.exports = {
    requireAuth,
    requireRole,
    requireAdmin,
    requirePermission,
    optionalAuth,
    guestOnly,
    roleHasPermission,
    isSuperAdminRole
};
