# Web Remote Only role (follow-up to #274)

Guest Access Links cover the “share a temporary RdClient URL with a friend” case without a panel account.

A dedicated **Web Remote Only** server role (e.g. `device.connect` without `device.view`, no Console inventory) remains a **follow-up** for permanent helpdesk/vendor accounts that need ongoing Web Remote access without seeing the full device list.

Until that lands, use:

1. **Guest Access Links** for short-lived external access, or
2. **Remote Operator + folder/user-group scope + restricted device visibility default** — see [SCOPED_REMOTE_USER.md](SCOPED_REMOTE_USER.md).
