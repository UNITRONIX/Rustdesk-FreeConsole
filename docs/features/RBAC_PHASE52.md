# RBAC Phase 52 — Granular Permissions, 6-Role Hierarchy & Data Scoping

> Implemented: 2026-04-10 | Updated: 2026-04-10 (6-role hierarchy) | Discussion: #99

## Overview

Phase 52 implements the full RBAC overhaul proposed in Discussion #99:
- **Phase 1**: JWT org context + org-scoped data filtering
- **Phase 2**: 28 granular permissions replacing role-level gates
- **Phase 3**: Super admin protection (self-demotion, role boundary, server admin)
- **Phase 4**: 6-role hierarchy (super_admin, server_admin, global_admin + legacy admin/operator/viewer/pro)
- **Phase 5**: Org role boundary enforcement + privilege escalation prevention
- **Phase 6**: Peer org-scoping on single-device endpoints

## 6-Role Hierarchy (Branched)

```
super_admin          ← Full access to everything, manages other super admins
├── server_admin     ← Server infrastructure only, read-only user visibility
├── global_admin     ← All-org user/device management, NO server access
└── admin            ← Legacy alias, equivalent to super_admin
    ├── operator     ← Day-to-day device ops + chat
    ├── viewer       ← Read-only dashboards
    └── pro          ← API-only device view
```

**Key design**: `server_admin` and `global_admin` are parallel roles — not one above the other.
They share the same privilege level (4) but have DIFFERENT permission sets.
Use `auth.CanAssignRole()` for role assignment boundaries instead of RoleLevel comparison.

## Changes

### New Files

| File | Description |
|------|-------------|
| `auth/permissions.go` | 28 permission constants, 7 default role maps, helpers |

### Modified Files

| File | Changes |
|------|---------|
| `auth/roles.go` | 7 role constants (super_admin, server_admin, global_admin, admin, operator, viewer, pro), branched `RoleLevel()`, `IsSuperAdminRole()`, `IsServerLevel()`, `CanAssignRole()` |
| `auth/jwt.go` | `OrgID` field in Claims, `GenerateOrgToken()` method |
| `db/database.go` | `User.IsServerAdmin`, `RolePermission` struct, `OrgRoleLevel()`, `OrgCanAssignRole()`, `ValidOrgRole()`, 5 new interface methods |
| `db/sqlite.go` | `role_permissions` table, `is_server_admin` column, 5 method implementations |
| `db/postgres.go` | Same as sqlite — table, column, 5 method implementations |
| `api/auth_handlers.go` | `requirePermission()` with super_admin bypass, `requireOrgMembership()` with global_admin bypass, `peerOrgScopeCheck()`, `CanAssignRole()` in create/update user, last-admin demotion guard |
| `api/server.go` | ~30 routes migrated to `requirePermission`, peer org scope checks on 7 single-device endpoints |
| `api/org_handlers.go` | Org login embeds `org_id` in JWT, org role boundary in create/update user, org user visibility scoping |
| `web-nodejs/middleware/auth.js` | 7 role permission maps, `isSuperAdminRole()`, updated `requireAdmin()` + `requireRole()` + `requirePermission()` |

## Permission System

### 28 Granular Permissions

| Category | Permissions |
|----------|------------|
| Device | `device.view`, `device.connect`, `device.edit`, `device.delete`, `device.ban`, `device.change_id` |
| User | `user.view`, `user.create`, `user.edit`, `user.delete` |
| Server | `server.config`, `server.keys` |
| Organization | `org.create`, `org.edit`, `org.delete`, `org.manage_users`, `org.manage_devices` |
| Audit | `audit.view`, `metrics.view`, `blocklist.edit` |
| CDAP | `cdap.view`, `cdap.command`, `cdap.terminal`, `cdap.files` |
| Enrollment | `enrollment.manage`, `enrollment.approve` |
| Other | `chat.access`, `branding.edit` |

### Default Role Mappings

| Role | # Permissions | Key Permissions |
|------|--------------|----------------|
| `super_admin` | All 28 | Everything |
| `admin` | All 28 | Legacy alias for super_admin |
| `server_admin` | 8 | server.config, server.keys, blocklist.edit, user.view (read-only!), device.view, audit.view, metrics.view, enrollment.manage |
| `global_admin` | 22 | user.*, org.*, device.*, audit.view, metrics.view, cdap.view/.command, chat.access, enrollment.*, branding.edit — **NO** server.config/server.keys |
| `operator` | 12 | device.view/.connect/.edit, user.view, audit.view, metrics.view, cdap.view/.command, enrollment.approve, chat.access, org.manage_devices |
| `viewer` | 5 | device.view, audit.view, metrics.view, cdap.view, chat.access |
| `pro` | 0 | API-only RustDesk PRO activation — no panel permissions |

### Role Assignment Boundaries

| Caller | Can Assign |
|--------|-----------|
| `super_admin` / `admin` | Any role |
| `global_admin` | `operator`, `viewer`, `pro` only |
| `server_admin` | Cannot assign any roles |
| `operator` / `viewer` / `pro` | Cannot assign any roles |

### Org Role Boundaries

| Caller Org Role | Can Assign |
|----------------|-----------|
| `owner` | `admin`, `operator`, `user` (not another `owner`) |
| `admin` | `operator`, `user` |
| `operator` / `user` | Cannot assign any roles |

### Custom Permission Overrides

The `role_permissions` table allows overriding defaults:

```sql
-- Grant operators the ability to delete devices
INSERT INTO role_permissions (role, permission, granted) VALUES ('operator', 'device.delete', true);

-- Revoke chat from viewers
INSERT INTO role_permissions (role, permission, granted) VALUES ('viewer', 'chat.access', false);
```

The `requirePermission` middleware checks DB overrides first, then falls back to defaults.

## Security Protections

| Protection | Description |
|-----------|-------------|
| Self-demotion prevention | Admins cannot lower their own role |
| Role boundary enforcement | `CanAssignRole()` enforces branched hierarchy — server_admin can't assign, global_admin only below GA |
| Server admin flag | `is_server_admin` field — only server admins can modify other server admins |
| Last-admin deletion guard | Cannot delete the sole remaining admin |
| Last-admin demotion guard | Cannot demote the last super_admin/admin (409 Conflict) |
| Org role boundary | `OrgCanAssignRole()` enforces org-level hierarchy (owner → admin/op/user, admin → op/user) |
| Org self-modification block | Cannot change own org role |
| Org authority check | Cannot modify users at or above own org-level authority |
| Peer org scoping | Org-scoped users can only access devices assigned to their org |
| Org user visibility | Org users can only see themselves in the user list |

## Data Scoping

| Endpoint | Scoping |
|----------|---------|
| `GET /api/peers` | Org-scoped users see only their org's devices via `ListPeersForOrg()` |
| `GET /api/peers/{id}` | `peerOrgScopeCheck()` — verifies peer belongs to caller's org |
| `DELETE /api/peers/{id}` | Same peer org scope check |
| `PATCH /api/peers/{id}` | Same peer org scope check |
| `POST /api/peers/{id}/ban` | Same peer org scope check |
| `POST /api/peers/{id}/unban` | Same peer org scope check |
| `POST /api/peers/{id}/change-id` | Same peer org scope check |
| `GET /api/peers/{id}/metrics` | Same peer org scope check |
| `GET /api/org/{id}/users` | Org users only see themselves; org admin/operator see all |
| `GET /api/orgs` | Non-admin users only see orgs they belong to |

## Database Schema

### New Table: `role_permissions`

```sql
CREATE TABLE role_permissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,
    permission TEXT NOT NULL,
    granted    INTEGER NOT NULL DEFAULT 1,
    UNIQUE(role, permission)
);
```

### New Column: `users.is_server_admin`

```sql
ALTER TABLE users ADD COLUMN is_server_admin INTEGER DEFAULT 0;
```

## API Response Changes

- `GET /api/auth/me` — now includes `is_server_admin` field
- `GET /api/users` — user list now includes `is_server_admin` field
- Error responses include specific permission names (e.g., `"Permission denied: device.delete"`)
