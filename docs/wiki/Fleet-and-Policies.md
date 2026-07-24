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

Access policies control **who can connect**, **when**, and **with which credentials**:

| Policy element | Description |
|----------------|-------------|
| **Schedule** | Time windows for unattended access |
| **Operator restrictions** | Limit which operators may connect |
| **Device password** | Bcrypt-hashed unattended password |
| **Approval** | Require user consent vs unattended |

Configure under **Policies** in the web panel or via Go API:

```bash
curl http://server:21114/api/access-policies \
  -H "X-API-Key: your-key"
```

See [[API Reference|API-Reference]] for CRUD endpoints.

---

## Unattended access

1. Set device password in policy or device detail
2. Define schedule (optional)
3. Operators connect without end-user prompt when policy allows

Wake-on-LAN for offline devices: device kebab menu → **Wake on LAN** (requires known MAC).

---

## Scoped remote users

Org-scoped and role-scoped users see only devices assigned to them. See [[Organizations and RBAC|Organizations-and-RBAC]] for tenant isolation.

---

## See also

- [[Web Console|Web-Console]] — Devices page actions
- [[Client Setup|Client-Setup]] — client-side login and AB sync
- [Scoped remote user doc](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/SCOPED_REMOTE_USER.md)
