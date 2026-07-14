# User Management

BetterDesk uses a **granular RBAC** system with server-level roles, optional **organization scoping**, and **28 permissions**. For multi-tenant deployments see [[Organizations and RBAC|Organizations-and-RBAC]].

---

## Server Roles

| Role | Panel | Typical use |
|------|-------|-------------|
| **super_admin** | Full | Primary administrator; all permissions |
| **admin** | Full | Legacy alias for `super_admin` |
| **server_admin** | Infrastructure | Server config, keys, metrics — read-only user list |
| **global_admin** | Users & orgs | Cross-org user/device management — no server settings |
| **operator** | Day-to-day | Connect, edit devices, chat, CDAP commands |
| **viewer** | Read-only | Dashboards and device list |
| **pro** | None (API only) | RustDesk Pro / automation via Client API |

### Role hierarchy (simplified)

```
super_admin / admin     → everything
├── server_admin        → server infrastructure (parallel branch)
├── global_admin        → all-org management (parallel branch)
└── operator / viewer / pro
```

> [!NOTE]
> `server_admin` and `global_admin` are **parallel** roles with different permission sets — not a strict parent/child chain. Only `super_admin` / `admin` can assign all roles.

### Permission highlights

| Role | Key permissions |
|------|-----------------|
| **super_admin** | All 28 permissions |
| **server_admin** | `server.config`, `server.keys`, `metrics.view`, `device.view` (read-only users) |
| **global_admin** | `user.*`, `org.*`, `device.*`, CDAP view/command — **no** `server.config` |
| **operator** | `device.view/connect/edit`, `chat.access`, `cdap.command`, `org.manage_devices` |
| **viewer** | `device.view`, `metrics.view`, `cdap.view`, `chat.access` |
| **pro** | Client API (port 21121) only — no panel permissions |

Custom overrides are stored in the `role_permissions` table (grant or revoke individual permissions per role).

---

## Managing Users

### Create a user

1. Log in as **super_admin**, **admin**, or **global_admin** (within role boundaries)
2. Go to **Users**
3. Click **Add User**
4. Enter username, password, and role
5. Click **Create**

### Edit / delete

- Use row actions on the **Users** page
- Admins cannot demote themselves or delete the last remaining super admin
- `server_admin` cannot assign roles

### Reset admin password

```bash
# Linux
sudo ./betterdesk.sh   # option 6 — Reset admin password

# Windows
.\betterdesk.ps1       # option 6

# Manual (Node.js console)
cd /opt/BetterDeskConsole
node reset-password.js
```

---

## TOTP Two-Factor Authentication

Compatible with Google Authenticator, Authy, and other TOTP apps.

### Enable 2FA

1. **Settings** → **Change Password**
2. **Enable 2FA** → scan QR code
3. Enter verification code and save recovery codes

### Login with 2FA

Enter username/password, then the 6-digit TOTP code (30-second window with tolerance).

### Recovery

- Use a one-time recovery code
- Another admin can disable 2FA from **Users**
- CLI password reset clears 2FA as well

---

## LDAP / Active Directory

Directory authentication for the web console and RustDesk desktop client. Configure under **Settings → Authentication → LDAP**. See [[LDAP / Active Directory|LDAP-AD]] for AD setup, group→role mapping, and client login steps.

---

## OIDC / SSO

External identity providers (Azure AD, Okta, Google, Keycloak) can replace or supplement local login. See [[OIDC SSO|OIDC-SSO]] for IdP configuration.

---

## Pro users (API-only)

Pro users have **no web panel access** — they authenticate against the **Client API** (port 21121).

```bash
curl -X POST http://your-server:21121/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "pro_user", "password": "secret"}'

curl http://your-server:21121/api/peers \
  -H "Authorization: Bearer eyJhbGci..."
```

See [[API Reference|API-Reference]] for all endpoints.

---

## Sessions & security

### Panel sessions
- Cookie: `HttpOnly`, `Secure` (when TLS enabled), `SameSite=Lax`
- Session regeneration on login (fixation protection)
- Configurable timeout in **Settings**

### RustDesk client sessions
- DB-backed tokens (default **7 days**, sliding renewal, max **30 days**)
- Configure under **Settings → Authentication → RustDesk clients**

### Password policy
- Minimum 6 characters, bcrypt hashing
- Timing-safe login (dummy hash for unknown users)

### Rate limiting
- 5 login attempts per minute per IP (password + TOTP)
- Failed attempts recorded in audit log

### Audit trail
Login, 2FA, password changes, user CRUD, and role changes are logged. Super admins can open **Security Audit** in the panel.

---

## See also

- [[Organizations and RBAC|Organizations-and-RBAC]] — org roles and data scoping
- [[LDAP / Active Directory|LDAP-AD]] — LDAP/AD sign-in
- [[OIDC SSO|OIDC-SSO]] — single sign-on
- [[Security]] — encryption and audit model
- [[API Reference|API-Reference]]
