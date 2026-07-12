# OIDC SSO

Configure **OpenID Connect (OIDC) / OAuth2** single sign-on so operators log in with Azure AD, Okta, Google, Keycloak, or any OIDC-compliant IdP.

---

## Overview

- Optional — local username/password login remains available unless disabled
- Panel login at **http://your-server:5000**
- Callback handled by the Go server API (typically port **21114**)
- Supports **PKCE** (recommended) and automatic issuer discovery

---

## Configuration (Settings → Authentication → OIDC)

| Field | Description |
|-------|-------------|
| **Enable OIDC** | Show SSO button on login page |
| **Identity provider** | Preset or custom |
| **Button display name** | e.g. "Sign in with Azure AD" |
| **Issuer URL** | OIDC issuer (`.well-known/openid-configuration` fetched automatically) |
| **Client ID** | OAuth2 client ID from your IdP |
| **Client secret** | OAuth2 client secret |
| **Redirect URL** | Must match IdP exactly — usually `http(s)://your-server:21114/api/auth/oidc/callback` |
| **Scopes** | Default `openid profile email` |
| **Use PKCE** | Recommended for public clients |
| **Auto provisioning** | Create local user on first SSO login (if enabled) |

> [!IMPORTANT]
> When using HTTPS behind a reverse proxy, set `TRUST_PROXY=true` in `.env` so redirect URLs and cookies use the correct scheme.

---

## IdP setup checklist

1. Register a new OAuth2/OIDC application in your IdP
2. Set redirect URI to match BetterDesk (see **Redirect URL** in Settings)
3. Copy Client ID and Client Secret into the panel
4. Enable PKCE if your IdP supports it
5. Test login from the panel login page

---

## User mapping

- First SSO login may create a user (if auto-provisioning enabled)
- If auto-provisioning is **disabled**, users must exist in BetterDesk first — otherwise login fails with `oidc_no_account`
- Map IdP groups to server roles manually after first login (or via future automation)

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `oidc_invalid` | State/nonce mismatch | Retry; check clock sync |
| `oidc_denied` | User cancelled or IdP denied | IdP policy / consent |
| `oidc_failed` | Token exchange failed | Verify client secret, redirect URL |
| `oidc_no_account` | User not in BetterDesk | Create user or enable auto-provisioning |

See [[Troubleshooting]] and [[FAQ]].

---

## See also

- [[User Management|User-Management]] — local users and 2FA
- [[Security]] — session and audit model
- [[Configuration]] — `TRUST_PROXY`
