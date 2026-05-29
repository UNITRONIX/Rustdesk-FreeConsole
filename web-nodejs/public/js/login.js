/**
 * BetterDesk Console - Login Page
 */

(function() {
    'use strict';
    
    document.addEventListener('DOMContentLoaded', init);
    
    function init() {
        const loginForm = document.getElementById('login-form');
        const totpForm = document.getElementById('totp-form');
        const passwordToggle = document.getElementById('password-toggle');
        const passwordInput = document.getElementById('password');
        const loginBtn = document.getElementById('login-btn');
        const totpBtn = document.getElementById('totp-btn');
        const errorContainer = document.getElementById('login-error');
        const errorMessage = document.getElementById('error-message');
        const toggleRecovery = document.getElementById('toggle-recovery');
        const totpBack = document.getElementById('totp-back');
        
        if (!loginForm) return;
        
        const csrfToken = window.BetterDesk?.csrfToken || '';

        // Check OIDC status and show SSO button if enabled
        checkOIDCStatus();
        
        // Password visibility toggle
        passwordToggle?.addEventListener('click', () => {
            const isPassword = passwordInput.type === 'password';
            passwordInput.type = isPassword ? 'text' : 'password';
            passwordToggle.querySelector('.material-icons').textContent = 
                isPassword ? 'visibility_off' : 'visibility';
        });
        
        // Login form submission
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            errorContainer.classList.add('hidden');
            
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const remember = document.getElementById('remember').checked;
            
            if (!username || !password) {
                showError(_('auth.fill_all_fields'));
                return;
            }
            
            loginBtn.classList.add('loading');
            loginBtn.disabled = true;
            
            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                    credentials: 'same-origin',
                    body: JSON.stringify({ username, password, remember })
                });
                
                // Safely parse response — server may return HTML on CSRF/middleware errors
                let data;
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    const text = await response.text();
                    try { data = JSON.parse(text); } catch (e) {
                        throw new Error(_('auth.login_failed'));
                    }
                }
                
                if (!response.ok) {
                    throw new Error(data.error || data.message || _('auth.login_failed'));
                }
                
                // Check if TOTP verification is required
                if (data.totpRequired) {
                    showTotpForm();
                    return;
                }
                
                // Success - redirect to dashboard
                window.location.href = data.redirect || '/';
                
            } catch (error) {
                showError(error.message);
            } finally {
                loginBtn.classList.remove('loading');
                loginBtn.disabled = false;
            }
        });
        
        // TOTP form submission
        totpForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            errorContainer.classList.add('hidden');
            
            const totpCode = document.getElementById('totp-code').value.trim();
            const recoveryCode = document.getElementById('recovery-code')?.value.trim();
            const recoveryGroup = document.getElementById('recovery-group');
            const useRecovery = recoveryGroup && !recoveryGroup.classList.contains('hidden');
            
            if (useRecovery) {
                if (!recoveryCode) {
                    showError(_('auth.totp_enter_recovery'));
                    return;
                }
            } else {
                if (!totpCode || totpCode.length !== 6) {
                    showError(_('auth.totp_enter_code'));
                    return;
                }
            }
            
            totpBtn.classList.add('loading');
            totpBtn.disabled = true;
            
            try {
                const body = useRecovery 
                    ? { recoveryCode } 
                    : { code: totpCode };
                
                const response = await fetch('/api/auth/totp/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                    credentials: 'same-origin',
                    body: JSON.stringify(body)
                });
                
                // Safely parse response
                let data;
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    const text = await response.text();
                    try { data = JSON.parse(text); } catch (e) {
                        throw new Error(_('auth.totp_invalid_code'));
                    }
                }
                
                if (!response.ok) {
                    throw new Error(data.error || _('auth.totp_invalid_code'));
                }
                
                window.location.href = data.redirect || '/';
                
            } catch (error) {
                showError(error.message);
            } finally {
                totpBtn.classList.remove('loading');
                totpBtn.disabled = false;
            }
        });
        
        // Toggle recovery code input
        toggleRecovery?.addEventListener('click', (e) => {
            e.preventDefault();
            const recoveryGroup = document.getElementById('recovery-group');
            const codeGroup = document.getElementById('totp-code-group');
            
            if (recoveryGroup.classList.contains('hidden')) {
                recoveryGroup.classList.remove('hidden');
                codeGroup.classList.add('hidden');
                document.getElementById('totp-code').removeAttribute('required');
                toggleRecovery.textContent = _('auth.totp_use_code');
            } else {
                recoveryGroup.classList.add('hidden');
                codeGroup.classList.remove('hidden');
                document.getElementById('totp-code').setAttribute('required', '');
                toggleRecovery.textContent = _('auth.totp_use_recovery');
            }
        });
        
        // Back to login from TOTP
        totpBack?.addEventListener('click', (e) => {
            e.preventDefault();
            hideTotpForm();
        });
        
        // Filter TOTP input to digits only
        document.getElementById('totp-code')?.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });
        
        function showTotpForm() {
            loginForm.classList.add('hidden');
            totpForm.classList.remove('hidden');
            errorContainer.classList.add('hidden');
            document.getElementById('totp-code').focus();
        }
        
        function hideTotpForm() {
            totpForm.classList.add('hidden');
            loginForm.classList.remove('hidden');
            errorContainer.classList.add('hidden');
            document.getElementById('totp-code').value = '';
            const recoveryInput = document.getElementById('recovery-code');
            if (recoveryInput) recoveryInput.value = '';
        }
        
        function showError(message) {
            errorMessage.textContent = message;
            errorContainer.classList.remove('hidden');
            
            errorContainer.style.animation = 'shake 0.5s ease';
            setTimeout(() => {
                errorContainer.style.animation = '';
            }, 500);
        }
    }

    /**
     * Check if OIDC/SSO is enabled and show the SSO button.
     */
    async function checkOIDCStatus() {
        try {
            const response = await fetch('/api/auth/oidc/status');
            if (!response.ok) return;
            const data = await response.json();
            if (data.enabled) {
                const ssoSection = document.getElementById('sso-section');
                const ssoBtnText = document.getElementById('sso-btn-text');
                if (ssoSection) {
                    ssoSection.classList.remove('hidden');
                }
                if (ssoBtnText && data.display_name) {
                    ssoBtnText.textContent = _('auth.login_sso_with', { provider: data.display_name }) || `Sign in with ${data.display_name}`;
                }
            }
        } catch (e) {
            // Silently ignore — SSO button stays hidden
        }
    }
    
    // Add shake animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
            20%, 40%, 60%, 80% { transform: translateX(5px); }
        }
    `;
    document.head.appendChild(style);
    
})();
