# Scoped remote user recipe

Guide for operators who need **limited device visibility**, **Web Client access**, and **self-service password change** — without using the `pro` panel role.

## Terminology

| BetterDesk role | Use for |
|-----------------|---------|
| **Remote Operator** (`operator`) | End users who connect remotely, use Web Client, change own password |
| **Viewer** (`viewer`) | Read-only monitoring (no Web Client) |
| **Pro License** (`pro`) | RustDesk desktop API / license activation only — **no web panel** |

RustDesk Pro **client features** are controlled separately via **strategy assignments**, not the `pro` role.

## Recipe: scoped remote user

1. **Create a user group** (Users → User groups) e.g. `Team-A`.
2. **Create folders** (Devices → Folders) and assign devices via drag-and-drop or folder picker.
3. **Restrict folder ACL**: edit folder → allowed users and/or allowed user groups.
4. **Create user** with role **Remote Operator**.
5. Assign **user groups**, **folders**, and/or **direct devices** in the user form.
6. Optional: assign a **RustDesk Pro strategy** on the same form for Pro client features.

## Default visibility modes

| Mode | Behavior |
|------|----------|
| **Restricted** (default) | Non-admins see only explicitly granted devices (folder/group ACL or direct peer grants). |
| **Open** | Non-admins with **no** explicit grants may still see devices that are not in a restricted folder/group. As soon as a user has any folder/group ACL or peer grant, they are allowlist-only (unassigned devices are not exposed). Folders and device groups with **no** allowed users/groups stay private until ACL is set. |

Empty folder/device-group ACL is **deny by default** (admins/`global_admin`/`server_admin` still bypass). Attach allowed users and/or user groups before expecting operators to see those devices.

**Stock RustDesk clients** use the Go Client API (`/api/ab`, `/api/peers`) with the same scope rules as the console. If panel ACL sync is unavailable (no PostgreSQL panel tables / missing `AUTH_DB_PATH` for legacy SQLite), non-admins receive **no** devices (fail closed) — not the full inventory. On Windows, BetterDeskServer NSSM must include `AUTH_DB_PATH` pointing at console `data\auth.db` (and read ACL for `NT SERVICE\BetterDeskServer`); panel update patches this automatically.

Operators who previously relied on Open + unassigned overlay while also granting specific folders should switch those users to explicit grants only, or keep Open only for accounts with zero ACL attachments.

## Password and Web Client

- **Password**: Remote Operator / Viewer → Settings → Change password (local accounts).
- **Web Client**: requires **Remote Operator** (`device.connect` permission).
- **Peer password**: device-group / folder ACL only limits **which machines appear** in the address book. Connecting still requires the target’s RustDesk permanent/temporary password (or on-screen approve). BetterDesk login does not bypass that peer handshake — see [Discussion #285](https://github.com/UNITRONIX/BetterDesk/discussions/285).

## Related

- [RBAC Phase 52](RBAC_PHASE52.md)
- GitHub discussion #227
- [GitHub discussion #285](https://github.com/UNITRONIX/BetterDesk/discussions/285) — login/groups vs peer password
