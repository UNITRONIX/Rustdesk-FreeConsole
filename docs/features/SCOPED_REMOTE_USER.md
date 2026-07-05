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
| **Open** (default) | Non-admins see all devices until folder/group ACL or direct grants exist |
| **Restricted** | Non-admins see only explicitly granted devices (Settings → Device visibility default) |

## Password and Web Client

- **Password**: Remote Operator / Viewer → Settings → Change password (local accounts).
- **Web Client**: requires **Remote Operator** (`device.connect` permission).

## Related

- [RBAC Phase 52](RBAC_PHASE52.md)
- GitHub discussion #227
