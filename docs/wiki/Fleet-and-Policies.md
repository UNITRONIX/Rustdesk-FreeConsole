# Fleet and Policies

Manage large device estates with **Fleet** grouping, **access policies**, and **unattended access** schedules.

---

## Fleet management

The **Fleet** page provides batch-oriented device operations:

| Feature | Description |
|---------|-------------|
| **Device groups** | Organize peers by tags, folders, or fleet definitions |
| **Batch actions** | Apply operations to multiple devices |
| **Scaling view** | Capacity and connection metrics for large deployments |
| **Inventory** | Hardware/software inventory from client sysinfo |

Fleet tools complement per-device actions on the **Devices** page. Use folders for operator UX; use fleet builder for scripted or bulk workflows.

---

## Access policies

Access policies store **scheduling metadata**, operator allowlists, and the unattended password for a device (panel / Go API).

| Policy element | Description |
|----------------|-------------|
| **Schedule** | Recorded time windows for unattended access (metadata; not yet enforced on punch/relay) |
| **Operator restrictions** | Stored allowlist of operators (enforced when fetching connect-secret) |
| **Device password** | Bcrypt hash (inventory) plus sealed ciphertext for Web Remote / RdClient auto-auth |
| **Approval** | Unattended vs supervised intent — Support Agent pulls console password when set |

Configure under **Devices → Access Policy** in the web panel or via Go API.

For **Support Agent**, saving a password with unattended enabled enables connect auto-auth and pushes the password to the device on pull. **Stock RustDesk** still needs the permanent password configured on the client.
---

## Unattended access

Two separate steps — both are required for hands-off remote access:

1. **On the target (Support Agent):** set unattended mode and a permanent access password (UI, branding `allow_unattended`, or Access Policy push from the console). Without this, the peer still prompts for a temporary password or on-screen approval.
2. **In BetterDesk:** record the same password under **Devices → Access Policy** with unattended enabled. The server stores a bcrypt hash (inventory) **and** a sealed copy used for operator **connect auto-auth**. Web Remote / RdClient fetch `/api/devices/:id/connect-secret` when the peer challenges with `Hash`, then authenticate without showing the password overlay. Support Agent pulls console-desired passwords periodically so the local permanent password matches.

Stock RustDesk peers still require the permanent password to be set on the client itself; Access Policy inventory alone does not push credentials to stock RustDesk.

Wake-on-LAN for offline devices: device kebab menu → **Wake on LAN** (requires known MAC).

---

## Scoped remote users

Org-scoped and role-scoped users see only devices assigned to them. See [[Organizations and RBAC|Organizations-and-RBAC]] for tenant isolation.

---

## See also

- [[Web Console|Web-Console]] — Devices page actions
- [[Client Setup|Client-Setup]] — client-side login and AB sync
- [Scoped remote user doc](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/SCOPED_REMOTE_USER.md)
