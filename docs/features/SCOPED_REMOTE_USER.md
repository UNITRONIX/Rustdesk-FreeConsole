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
| **Open** (default) | Non-admins see devices that are not in a restricted folder/group. Folders and device groups with **no** allowed users/groups are private (hidden from non-admins) until ACL is set. Direct peer grants always apply. |
| **Restricted** | Non-admins see only explicitly granted devices (Settings → Device visibility default) |

Empty folder/device-group ACL is **deny by default** (admins/`global_admin`/`server_admin` still bypass). Attach allowed users and/or user groups before expecting operators to see those devices.

## Password and Web Client

- **Password**: Remote Operator / Viewer → Settings → Change password (local accounts).
- **Web Client**: requires **Remote Operator** (`device.connect` permission).
- **Peer password**: device-group / folder ACL only limits **which machines appear** in the address book. Connecting still requires the target’s RustDesk permanent/temporary password (or on-screen approve). BetterDesk login does not bypass that peer handshake — see [Discussion #285](https://github.com/UNITRONIX/BetterDesk/discussions/285).

## Related

- [RBAC Phase 52](RBAC_PHASE52.md)
- GitHub discussion #227
- [GitHub discussion #285](https://github.com/UNITRONIX/BetterDesk/discussions/285) — login/groups vs peer password
