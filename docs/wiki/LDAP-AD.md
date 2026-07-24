# LDAP / Active Directory

Configure **LDAP or Active Directory** authentication so operators sign in with domain credentials in the web console and in the RustDesk desktop client.

---

## Overview

- Optional — existing **local** accounts keep using local passwords; **LDAP** accounts use directory credentials only (no cross-provider fallthrough)
- Panel login at **http://your-server:5000** (or HTTPS **5443**)
- LDAP settings are stored in the Go server database (`server_config`, keys prefixed `ldap.*`)
- **RustDesk desktop client** uses the same directory authentication via `POST /api/login` on the Go API (port **21114**, or **21121** through the Client API proxy)
- Users are **auto-provisioned** on first successful LDAP login (role from group mapping or default role)

> [!IMPORTANT]
> Each BetterDesk user has a fixed **auth provider** (`local`, `ldap`, or `oidc`). LDAP-bound accounts authenticate only with directory credentials — local password login is rejected for those users, and vice versa.

> [!TIP]
> In the web console open **Settings → Authentication → LDAP / AD** (Development channel uses Authentication **sub-tabs**; the first tab is Enrollment, not LDAP).

---

## Configuration (Settings → Authentication → LDAP / AD)

| Field | Description |
|-------|-------------|
| **Enable LDAP Authentication** | Turn on directory sign-in for the panel and RustDesk client |
| **Host / Port** | LDAP server address (389 plain, 636 LDAPS) |
| **LDAPS (TLS)** | Connect with TLS on port 636 |
| **StartTLS** | Upgrade plain connection with STARTTLS |
| **Skip TLS verify** | Dev/lab only — do not use in production |
| **Connection timeout (s)** | Seconds to wait for LDAP server response |
| **Bind Mode** | Service-account search (default) or **Direct Bind** |
| **Bind DN / Bind Password** | Read-only service account for user search (bind+search mode) |
| **Base DN** | Search base, e.g. `dc=example,dc=com` |
| **User Filter** | LDAP filter with `{{username}}` placeholder. AD default: `(sAMAccountName={{username}})` |
| **Direct Bind DN Template** | Direct bind only — e.g. `uid={{username}},ou=users,dc=example,dc=com` |
| **Username / Email / Display Name Attribute** | LDAP attributes mapped to BetterDesk user fields |
| **Group → Role Map** | Pipe-separated `GroupDN=role` entries (roles: `viewer`, `operator`, `admin`) |
| **Default Role** | Role when no group mapping matches |
| **Test Connection** | Validates reachability and bind credentials before save |

### Bind modes

**Bind + search (recommended for Active Directory)**

1. Service account binds to LDAP
2. Server searches for the user DN using **User Filter**
3. Server binds again as the user with the supplied password
4. Group membership is resolved for role mapping

**Direct bind**

- Skips search; builds user DN from **Direct Bind DN Template**
- Useful for simple OpenLDAP layouts without a service account
- Group → role mapping may be limited depending on directory layout

---

## Active Directory checklist

1. Create a **read-only** service account for LDAP bind (bind+search mode)
2. Set **Host** to domain controller or Global Catalog
3. Use **Base DN** = domain root, e.g. `dc=corp,dc=local`
4. Keep default **User Filter**: `(sAMAccountName={{username}})`
5. Map AD groups, e.g. `CN=BetterDesk-Admins,OU=Groups,DC=corp,DC=local=admin|CN=BetterDesk-Ops,OU=Groups,DC=corp,DC=local=operator`
6. Click **Test Connection**, then **Save**
7. Sign in to the panel with an AD username (sAMAccountName, not UPN, unless your filter uses `userPrincipalName`)

---

## RustDesk desktop client login

After LDAP is enabled and saved:

1. Update BetterDesk to a build that includes RustDesk client LDAP support (**v3.3.64+** on the **Development** update channel — Settings → Updates → Update channel)
2. Confirm web console LDAP login works for the same account
3. In the RustDesk client: account icon → **Login**
4. Server URL: `http(s)://<your-server>:21114` (direct Go API) or `:21121` (Client API proxy)
5. Username: same as web console (typically sAMAccountName)
6. Password: domain password

On success the client receives a session token and syncs the address book. **TOTP/2FA** applies when enabled on the BetterDesk user account.

Browser redirect / OIDC for the desktop app is supported when OIDC is enabled under Settings → Authentication — see [[OIDC SSO|OIDC-SSO]]. LDAP password login does not require OIDC.

---

## User management notes

- LDAP users appear in **Users** with provider badge **LDAP/AD**
- Password and role are managed by the directory (group mapping on each login); the panel blocks local password changes for LDAP accounts
- Deleting a user in the panel does not remove the AD account — they can auto-provision again on next LDAP login unless you disable auto-provisioning
- Avoid creating a **local** user with the same username as an AD account; LDAP login for unknown usernames auto-creates an `ldap` provider account

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Cannot find LDAP settings | Looking at Enrollment sub-tab only | Open **Settings → Authentication → LDAP / AD** |
| Test connection fails | Wrong host, port, TLS mode, or bind DN/password | Verify LDAPS vs StartTLS; check firewall to DC |
| Web LDAP login works, client says "Invalid credentials" | Server not updated to LDAP client login build, or Go not restarted | Update via Settings → Updates on the **Development** channel (v3.3.64+); restart BetterDeskServer |
| Local password works in panel but not in RustDesk client (SQLite dual-DB) | Go `users` row was created with a placeholder password | Change the password once in the panel (mirrors to Go), or update to a build that copies the panel password hash on backfill |
| Valid AD password rejected in panel | User exists as `local` provider | Remove or rename local collision; use LDAP-only account |
| Local password rejected after LDAP attempts | Account `auth_provider` is already `ldap` | Use directory password, or recreate as a local user with a different username |
| User gets wrong role | Group map mismatch | Check **Group → Role Map** DNs; confirm **Default Role** |
| TLS / certificate errors | Self-signed or private CA | Install trusted CA on server, or use lab-only **Skip TLS verify** |
| Login works but no email/display name | Attribute mapping | Set **Email Attribute** / **Display Name Attribute** to AD attrs (`mail`, `displayName`) |

See [[Troubleshooting]], [[OIDC SSO|OIDC-SSO]] (alternative SSO path), and [[User Management|User-Management]].

---

## See also

- [[User Management|User-Management]] — roles, 2FA, provider-bound accounts
- [[OIDC SSO|OIDC-SSO]] — browser-based SSO (Azure AD, Okta, etc.)
- [[Panel Updates|Panel-Updates]] — stable vs development update channel
- [[Desktop Clients|Desktop-Clients]] — RustDesk client setup
- [[Security]] — audit log and session model
