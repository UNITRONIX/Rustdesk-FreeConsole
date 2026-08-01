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

Access policies store **inventory and scheduling metadata** for a device (panel / Go API). They do **not** replace the RustDesk peer password handshake and are **not enforced at connect time** on punch/relay today.

| Policy element | Description |
|----------------|-------------|
| **Schedule** | Recorded time windows for unattended access (metadata) |
| **Operator restrictions** | Stored allowlist of operators (not enforced on peer connect yet) |
| **Device password** | Bcrypt hash of the unattended password (inventory / reference) |
| **Approval** | Notes attended vs unattended intent — target client config still applies |

Configure under **Policies** in the web panel or via Go API:

```bash
curl http://server:21114/api/access-policies \
  -H "X-API-Key: your-key"
```

See [[API Reference|API-Reference]] for CRUD endpoints.

---

## Unattended access

Two separate steps — both are required for hands-off remote access:

1. **On the target:** configure RustDesk for unattended access (permanent password via `--password`, client Security settings, or BetterDesk Agent Client unattended mode). Without this, the peer still prompts for a temporary password or on-screen approval.
2. **In BetterDesk (optional):** record the same password / schedule under Access Policy for inventory and operator reference. This does **not** push credentials to stock RustDesk or skip the peer login prompt.

Operators still enter the **target peer password** when connecting (desktop RustDesk, Web Remote, or RdClient). BetterDesk account login and device-group membership only control **visibility** (address book / ACL) and audit attribution — not passwordless peer connect.

Wake-on-LAN for offline devices: device kebab menu → **Wake on LAN** (requires known MAC).

---

## Scoped remote users

Org-scoped and role-scoped users see only devices assigned to them. See [[Organizations and RBAC|Organizations-and-RBAC]] for tenant isolation.

---

## See also

- [[Web Console|Web-Console]] — Devices page actions
- [[Client Setup|Client-Setup]] — client-side login and AB sync
- [Scoped remote user doc](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/SCOPED_REMOTE_USER.md)
