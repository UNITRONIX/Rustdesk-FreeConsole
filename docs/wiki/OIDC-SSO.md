# OIDC SSO

Configure **OpenID Connect (OIDC) / OAuth2** single sign-on so operators log in with Azure AD, Okta, Google, Keycloak, or any OIDC-compliant IdP.

---

## Overview

- Optional — local username/password login remains available unless disabled
- Panel login at **http://your-server:5000**
- IdP callback handled by the Go server API (typically port **21114** or **21121** in Docker)
- Session cookie created by the Node.js panel after callback (same host/port as the login page)
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
| **Redirect URL** | Must match IdP exactly — usually `http(s)://your-server:21114/api/auth/oidc/callback` (Docker all-in-one: port **21121**) |
| **Panel URL** | URL operators use to open the web console — e.g. `http(s)://your-server:5000` or your reverse-proxy hostname. **Required** when callback runs on the Go API port (Docker, split-port installs). Auto-filled from the browser when you save settings. |
| **Scopes** | Default `openid profile email` |
| **Use PKCE** | Recommended for public clients |
| **Auto provisioning** | Create local user on first SSO login (if enabled) |

> [!IMPORTANT]
> When using HTTPS behind a reverse proxy, set `TRUST_PROXY=true` in `.env` so redirect URLs and cookies use the correct scheme.

You can also set **`PANEL_PUBLIC_URL`** in the console `.env` as a fallback panel origin for OIDC session redirects.

---

## Docker / split-port note

The all-in-one Docker image exposes:

- **:5000** — web console (login UI, session cookies)
- **:21121** — Go API (OIDC callback)

After Keycloak redirects to the Go callback, BetterDesk sends the browser to **Panel URL** `/api/auth/oidc/session` to finish login. Set **Panel URL** to how operators reach the console (e.g. `http://192.168.1.10:5000`).

---

## Reverse proxy (single hostname)

When TLS terminates on Caddy/Nginx, use one public hostname and route:

| Path | Upstream |
|------|----------|
| `/api/auth/oidc/callback` | Go API (`127.0.0.1:21114` or `:21121`) |
| `/api/auth/oidc/session` | Node panel (`127.0.0.1:5000`) |
| `/` (everything else) | Node panel (`127.0.0.1:5000`) |

Set **Redirect URL** to `https://your-host/api/auth/oidc/callback` and **Panel URL** to `https://your-host`.

See [REVERSE_PROXY.md](../setup/REVERSE_PROXY.md).

---

## IdP setup checklist

1. Register a new OAuth2/OIDC application in your IdP
2. Set redirect URI to match BetterDesk (see **Redirect URL** in Settings)
3. Copy Client ID and Client Secret into the panel
4. Set **Panel URL** to the console origin operators use
5. Enable PKCE if your IdP supports it
6. Test login from the panel login page

---

## User mapping

- First SSO login may create a user (if auto-provisioning enabled)
- If auto-provisioning is **disabled**, users must exist in BetterDesk first — otherwise login fails with `oidc_no_account`
- Map IdP groups to server roles manually after first login (or via future automation)

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid or missing credentials` (JSON) | Browser hit Go API for `/api/auth/oidc/session` instead of the panel | Set **Panel URL** in OIDC settings (or `PANEL_PUBLIC_URL`); use reverse-proxy path rules |
| `oidc_invalid` | State/nonce mismatch or bad auth code | Retry; check clock sync |
| `oidc_denied` | User cancelled or IdP denied | IdP policy / consent |
| `oidc_failed` | Token exchange failed | Verify client secret, redirect URL |
| `oidc_no_account` | User not in BetterDesk | Create user or enable auto-provisioning |

See [[Troubleshooting]] and [[FAQ]].

---

## See also

- [[User Management|User-Management]] — local users and 2FA
- [[Security]] — session and audit model
- [[Configuration]] — `TRUST_PROXY`, `PANEL_PUBLIC_URL`
