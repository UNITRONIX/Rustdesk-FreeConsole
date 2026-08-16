/**
 * Windows client app_name allowlist for BetterDesk API login.
 * Mobile (android/ios) always allowed; Windows requires allowlisted app_name.
 *
 * Env:
 *   BETTERDESK_WINDOWS_CLIENT_APP_NAME_GATE — default true
 *   BETTERDESK_ALLOWED_WINDOWS_APP_NAMES — comma list, default "DCS Norway"
 */

const ENV_GATE = 'BETTERDESK_WINDOWS_CLIENT_APP_NAME_GATE';
const ENV_ALLOW = 'BETTERDESK_ALLOWED_WINDOWS_APP_NAMES';
const DEFAULT_APP = 'DCS-Norway-RD';
const ERROR_MSG =
    'Unsupported Windows client. Use the DCS Norway Remote Desktop Client (or set BETTERDESK_WINDOWS_CLIENT_APP_NAME_GATE=false).';

function gateEnabled() {
    const v = String(process.env[ENV_GATE] || '').trim().toLowerCase();
    if (!v) return true;
    return v === 'true' || v === '1' || v === 'yes' || v === 'y';
}

function allowedAppNames() {
    const raw = String(process.env[ENV_ALLOW] || '').trim() || DEFAULT_APP;
    return new Set(
        raw.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    );
}

function normalizeOs(osName) {
    return String(osName || '').trim().toLowerCase();
}

function isMobileOs(osName) {
    const o = normalizeOs(osName);
    return (
        o === 'android' ||
        o === 'ios' ||
        o.includes('android') ||
        o.includes('iphone') ||
        o.includes('ipad')
    );
}

function isWindowsOs(osName) {
    const o = normalizeOs(osName);
    return o === 'windows' || o.startsWith('windows');
}

/**
 * @param {string} osName
 * @param {string} appName
 * @returns {string} error message if rejected, else ''
 */
function rejectWindowsClientAppName(osName, appName) {
    if (!gateEnabled()) return '';
    if (isMobileOs(osName)) return '';
    if (!isWindowsOs(osName)) return '';
    const name = String(appName || '').trim();
    if (allowedAppNames().has(name)) return '';
    return ERROR_MSG;
}

module.exports = {
    rejectWindowsClientAppName,
    gateEnabled,
    ERROR_MSG,
    ENV_GATE,
    ENV_ALLOW,
    DEFAULT_APP
};
