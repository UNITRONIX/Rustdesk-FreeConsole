/**
 * BetterDesk Console - Auth Routes
 * Login, logout, session verification
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const db = require('../services/database');
const betterdeskApi = require('../services/betterdeskApi');
const { guestOnly, requireAuth } = require('../middleware/auth');
const { loginLimiter, passwordChangeLimiter } = require('../middleware/rateLimiter');

/**
 * Validate that a return URL is a safe relative path. Mirrors
 * auth.IsRelativeReturnURL in the Go server. Rejects absolute URLs,
 * protocol-relative URLs (//evil.com/...), CR/LF (response splitting),
 * and anything not starting with a single "/".
 */
function isSafeReturnUrl(u) {
    if (typeof u !== 'string' || u.length === 0) return false;
    if (/[\r\n\x00]/.test(u)) return false;
    if (!u.startsWith('/')) return false;
    if (u.startsWith('//') || u.startsWith('/\\')) return false;
    return true;
}

/**
 * GET /login - Login page
 * Serves desktop-style login when user previously had desktop mode active
 * (detected via localStorage preference or explicit ?desktop=1 query param).
 */
router.get('/login', guestOnly, async (req, res) => {
    const useDesktop = req.query.desktop === '1' || req.cookies.betterdesk_desktop_mode === 'true';

    if (useDesktop) {
        // Fetch user list for multi-user selector (usernames + roles only, no secrets)
        let loginUsers = [];
        try {
            const users = typeof db.getAllUsersForBackup === 'function'
                ? await db.getAllUsersForBackup() : [];
            loginUsers = (Array.isArray(users) ? users : []).map(u => ({
                username: u.username,
                role: u.role || 'operator'
            }));
        } catch (_) { /* empty list is fine */ }

        return res.render('desktop-login', {
            title: req.t('nav.login'),
            activePage: 'login',
            loginUsers
        });
    }

    res.render('login', {
        title: req.t('nav.login'),
        activePage: 'login'
    });
});

/**
 * POST /api/auth/login - Login API
 */
router.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.invalid_credentials')
            });
        }

        // Input length validation to prevent DoS via bcrypt
        if (username.length > 128 || password.length > 128) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.invalid_credentials')
            });
        }
        
        const user = await authService.authenticate(username, password);
        
        if (!user) {
            // Record failed attempt (shared brute-force tracker with /api/bd/operator/login)
            authService.recordAttempt(username, req.ip, false);
            await db.logAction(null, 'login_failed', `Username: ${username}`, req.ip);
            
            return res.status(401).json({
                success: false,
                error: req.t('auth.invalid_credentials')
            });
        }
        
        // Clear brute-force lockout on successful auth (shared with operator_login)
        authService.recordAttempt(username, req.ip, true);
        
        // Block pro-only accounts from web panel login
        if (user.role === 'pro') {
            return res.status(403).json({
                success: false,
                error: req.t('auth.pro_only_account')
            });
        }
        
        // Check if TOTP verification is required
        if (user.totpRequired) {
            // Store pending 2FA session
            req.session.pendingTotpUserId = user.id;
            req.session.pendingTotpUser = user;
            // Phase A: store Go partial token for delegated TOTP verification
            if (user.goPartialToken) {
                req.session.goPartialToken = user.goPartialToken;
            }
            
            return res.json({
                success: true,
                totpRequired: true
            });
        }
        
        // Regenerate session to prevent session fixation
        const oldSession = req.session;
        req.session.regenerate(async (err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ success: false, error: 'Server error' });
            }
            
            // Restore session data
            req.session.userId = user.id;
            req.session.user = {
                id: user.id,
                username: user.username,
                role: user.role
            };
            // Phase A: store emergency mode flag in session for UI banner
            if (user.emergencyMode) {
                req.session.emergencyMode = true;
            }
            
            // Log successful login
            await db.logAction(user.id, 'login', `User logged in`, req.ip);
            
            res.json({
                success: true,
                user: {
                    username: user.username,
                    role: user.role
                }
            });
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/auth/logout - Logout API
 */
router.post('/api/auth/logout', async (req, res) => {
    const userId = req.session?.userId;
    
    if (userId) {
        await db.logAction(userId, 'logout', 'User logged out', req.ip);
    }
    
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
        }
        res.clearCookie(req.sessionID ? req.session?.cookie?.name : 'betterdesk.sid');
        res.clearCookie('betterdesk.sid');
        res.clearCookie('bd.sid');
        res.json({ success: true });
    });
});

/**
 * GET /api/auth/verify - Verify session is valid
 */
router.get('/api/auth/verify', requireAuth, (req, res) => {
    res.json({
        success: true,
        user: req.session.user
    });
});

/**
 * POST /api/auth/password - Change password
 */
router.post('/api/auth/password', requireAuth, passwordChangeLimiter, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.password_required')
            });
        }
        
        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.passwords_mismatch')
            });
        }
        
        const result = await authService.changePassword(
            req.session.userId,
            currentPassword,
            newPassword
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }
        
        // Log password change
        await db.logAction(req.session.userId, 'password_changed', 'Password changed', req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /logout - Logout (redirect)
 */
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('betterdesk.sid');
        res.clearCookie('bd.sid');
        res.redirect('/login');
    });
});

// ==================== OIDC/OAuth2 Routes ====================

const crypto = require('crypto');
const bcrypt = require('bcrypt');

/**
 * GET /api/auth/oidc/status - Public endpoint for login page
 * Returns whether OIDC is enabled and the display name for the button.
 */
router.get('/api/auth/oidc/status', async (req, res) => {
    try {
        const result = await betterdeskApi.getOIDCStatus();
        if (!result.success) {
            return res.json({ enabled: false });
        }
        res.json(result.data);
    } catch (err) {
        res.json({ enabled: false });
    }
});

/**
 * GET /api/auth/oidc/authorize - Redirect to OIDC IdP
 * Proxies to Go server which handles state/nonce/PKCE generation.
 * return_url is validated as a relative path before forwarding.
 */
router.get('/api/auth/oidc/authorize', (req, res) => {
    // BETTERDESK_API_URL may or may not include a trailing /api segment
    // (it does in config.js for axios baseURL use). Strip it before building
    // the absolute redirect to avoid a doubled /api/api/... path.
    const rawApiUrl = process.env.BETTERDESK_API_URL || 'http://localhost:21114';
    const goApiUrl = rawApiUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const requested = typeof req.query.return_url === 'string' ? req.query.return_url : '/';
    const returnUrl = isSafeReturnUrl(requested) ? requested : '/';
    res.redirect(`${goApiUrl}/api/auth/oidc/authorize?return_url=${encodeURIComponent(returnUrl)}`);
});

/**
 * GET /api/auth/oidc/session - Session creation after OIDC callback.
 *
 * Security model: Go server NEVER passes the JWT or user identity through
 * the browser URL bar. Instead the IdP callback handler stores a one-time
 * auth code (60s TTL) and redirects here with only `?code=<32 bytes>`.
 * Node.js POSTs back to Go's /api/auth/oidc/exchange (server-to-server)
 * to retrieve the JWT plus the verified username/role.
 *
 * This prevents JWT/role leakage via:
 *   - browser history / Referer headers
 *   - access logs (Go, Node.js, reverse proxy)
 *   - role spoofing through URL tampering
 */
router.get('/api/auth/oidc/session', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';

    if (!code) {
        return res.redirect('/login?error=oidc_invalid');
    }

    try {
        // Server-to-server exchange. Go returns { token, username, role, return_url }
        // only for a valid, unconsumed, unexpired code.
        const exchange = await betterdeskApi.exchangeOIDCCode(code);
        if (!exchange || !exchange.success || !exchange.data || !exchange.data.token || !exchange.data.username) {
            console.warn('[OIDC] Exchange rejected by Go server');
            return res.redirect('/login?error=oidc_invalid');
        }

        const { token, username, role, return_url } = exchange.data;

        // Defense in depth: re-validate the return URL Go provided.
        const safeReturnUrl = isSafeReturnUrl(return_url) ? return_url : '/';

        // Look up the local user (may have been auto-provisioned by Go).
        let user = await db.getUserByUsername(username);

        if (!user) {
            // Mirror Go-side auto-provisioning into auth.db so sessions persist
            // and middleware/RBAC can resolve the user ID locally.
            const randomPass = crypto.randomBytes(32).toString('hex');
            const hash = await bcrypt.hash(randomPass, 12);
            try {
                await db.createUser(username, hash, role || 'viewer');
            } catch (err) {
                console.error('[OIDC] Failed to auto-provision local user', username, err.message);
            }
            user = await db.getUserByUsername(username);
        }

        if (!user) {
            return res.redirect('/login?error=oidc_error');
        }

        // Regenerate session to prevent fixation across the authentication boundary.
        req.session.regenerate((err) => {
            if (err) {
                console.error('OIDC session regenerate error:', err);
                return res.redirect('/login?error=oidc_error');
            }

            // Trust the role from the exchange response (server-to-server), not
            // the URL. Fall back to the locally stored role only if Go omitted one.
            const effectiveRole = role || user.role || 'viewer';

            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = effectiveRole;
            req.session.user = {
                id: user.id,
                username: user.username,
                role: effectiveRole,
                preferred_language: user.preferred_language || null
            };
            req.session.goToken = token;
            req.session.authMethod = 'oidc';

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('OIDC session save error:', saveErr);
                    return res.redirect('/login?error=oidc_error');
                }
                res.redirect(safeReturnUrl);
            });
        });
    } catch (err) {
        console.error('OIDC session creation error:', err);
        res.redirect('/login?error=oidc_error');
    }
});

// ==================== TOTP (2FA) Routes ====================

/**
 * POST /api/auth/totp/verify - Verify TOTP code during login
 *
 * Phase A: If goPartialToken is present in session, delegate verification
 * to Go server's POST /api/auth/login/2fa. Otherwise fall back to local
 * verification (emergency mode or legacy).
 */
router.post('/api/auth/totp/verify', loginLimiter, async (req, res) => {
    try {
        const { code, recoveryCode } = req.body;
        const pendingUserId = req.session.pendingTotpUserId;
        const pendingUser = req.session.pendingTotpUser;
        const goPartialToken = req.session.goPartialToken;
        
        if (!pendingUserId || !pendingUser) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.totp_session_expired')
            });
        }

        const totpCode = code || recoveryCode || '';

        // --- Phase A: Delegate to Go server when partial token available ---
        if (goPartialToken) {
            const goResult = await authService.verifyTotpViaGo(goPartialToken, totpCode);

            if (!goResult) {
                // Go unreachable — don't lock user out, fall through to local
                console.warn('[AUTH] Go server unreachable during 2FA — falling back to local verification');
            } else if (goResult.rejected) {
                if (goResult.rateLimited) {
                    return res.status(429).json({
                        success: false,
                        error: req.t('auth.totp_rate_limited') || 'Too many attempts. Please try again later.'
                    });
                }
                await db.logAction(pendingUserId, 'totp_failed', 'Go server rejected TOTP', req.ip);
                return res.status(401).json({
                    success: false,
                    error: req.t('auth.totp_invalid_code')
                });
            } else if (goResult.token) {
                // Go accepted — create session
                return finalizeLoginSession(req, res, pendingUser, 'totp (Go delegated)');
            }
        }

        // --- Local TOTP verification (fallback or emergency mode) ---
        let verified = false;
        let method = 'totp';
        
        if (recoveryCode) {
            verified = await authService.verifyRecoveryCode(pendingUserId, recoveryCode);
            method = 'recovery';
        } else if (code) {
            verified = await authService.verifyTotpCode(pendingUserId, code);
        }
        
        if (!verified) {
            await db.logAction(pendingUserId, 'totp_failed', `Method: ${method}`, req.ip);
            return res.status(401).json({
                success: false,
                error: req.t('auth.totp_invalid_code')
            });
        }

        return finalizeLoginSession(req, res, pendingUser, `${method} (local)`);
    } catch (err) {
        console.error('TOTP verify error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * Finalize login session after successful 2FA verification.
 * Regenerates session, sets user data, logs action.
 */
function finalizeLoginSession(req, res, pendingUser, method) {
    return new Promise((resolve) => {
        req.session.regenerate(async (regenErr) => {
            if (regenErr) {
                console.error('TOTP session regeneration error:', regenErr);
                res.status(500).json({
                    success: false,
                    error: 'Server error'
                });
                return resolve();
            }

            req.session.userId = pendingUser.id;
            req.session.user = {
                id: pendingUser.id,
                username: pendingUser.username,
                role: pendingUser.role
            };

            try {
                await db.updateLastLogin(pendingUser.id);
                await db.logAction(pendingUser.id, 'login', `User logged in (2FA: ${method})`, req.ip);
            } catch (logErr) {
                console.error('TOTP post-auth bookkeeping error:', logErr);
            }

            res.json({
                success: true,
                user: {
                    username: pendingUser.username,
                    role: pendingUser.role
                }
            });
            resolve();
        });
    });
}

/**
 * POST /api/auth/totp/setup - Generate TOTP setup (QR code + secret)
 */
router.post('/api/auth/totp/setup', requireAuth, async (req, res) => {
    try {
        // Check if already enabled
        if (await authService.isTotpEnabled(req.session.userId)) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.totp_already_enabled')
            });
        }
        
        const result = await authService.generateTotpSetup(req.session.userId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }
        
        res.json({
            success: true,
            qrCode: result.qrCode,
            secret: result.secret,
            otpauthUrl: result.otpauthUrl
        });
    } catch (err) {
        console.error('TOTP setup error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/auth/totp/enable - Verify code and enable TOTP
 */
router.post('/api/auth/totp/enable', requireAuth, async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code || code.length !== 6) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.totp_invalid_code')
            });
        }
        
        const result = await authService.verifyAndEnableTotp(req.session.userId, code);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }
        
        // Log action
        await db.logAction(req.session.userId, 'totp_enabled', '2FA enabled', req.ip);
        
        res.json({
            success: true,
            recoveryCodes: result.recoveryCodes
        });
    } catch (err) {
        console.error('TOTP enable error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/auth/totp/disable - Disable TOTP
 */
router.post('/api/auth/totp/disable', requireAuth, async (req, res) => {
    try {
        const { password } = req.body;
        
        if (!password) {
            return res.status(400).json({
                success: false,
                error: req.t('auth.password_required')
            });
        }
        
        // Verify password before disabling (supports both bcrypt and PBKDF2 hashes)
        const user = await db.getUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        const valid = await authService.verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({
                success: false,
                error: req.t('auth.invalid_credentials')
            });
        }
        
        await authService.disableTotp(req.session.userId);
        
        // Log action
        await db.logAction(req.session.userId, 'totp_disabled', '2FA disabled', req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('TOTP disable error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/auth/totp/status - Check if TOTP is enabled for current user
 */
router.get('/api/auth/totp/status', requireAuth, async (req, res) => {
    try {
        const enabled = await authService.isTotpEnabled(req.session.userId);
        res.json({ success: true, enabled });
    } catch (err) {
        console.error('TOTP status error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

module.exports = router;
