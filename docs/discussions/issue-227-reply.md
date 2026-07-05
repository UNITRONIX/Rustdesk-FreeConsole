# Reply for GitHub discussion #227 (copy/paste)

---

Hi — thanks for raising this, it helped us spot a naming mix-up that trips people up often.

**Short version:** In BetterDesk, the panel role called **Pro** is *not* what most people mean by a “Pro end user”. It’s a special **license/API-only** account (RustDesk desktop client, no web panel). If you want someone who can log into the console, change their password, use the Web Client, and only see *their* machines — that’s a **Remote Operator**, not `pro`.

### What already works today

For a typical “remote user with limited visibility”:

1. Create the user as **Remote Operator** (was just labeled “Operator” in the UI).
2. **Password:** they can change it themselves under **Settings → Change password** (local accounts).
3. **Web Client:** Remote Operators can use **Remote Desktop** in the panel (`device.connect`). Viewers are read-only and cannot connect.
4. **Limit which devices they see:**
   - Put devices in **folders** and set folder access (allowed users / user groups), **or**
   - Use **user groups** + device group ACL (same idea as before).

### What we’re shipping to make this easier

On the next update (via **Settings → Updates**):

- **User Management:** assign **folders**, **direct devices**, and an optional **RustDesk Pro strategy** per user — all in one place.
- Clearer role names in the UI: **Remote Operator** vs **Pro License (client API only)**.
- Optional **restricted default visibility** in Settings (for servers that want “see nothing until explicitly granted” instead of “see everything until ACL is set”).

Docs for operators: [Scoped remote user recipe](https://github.com/UNITRONIX/BetterDesk/blob/dev/docs/features/SCOPED_REMOTE_USER.md)

### When to use the `pro` role

Keep **`pro`** for accounts that only need to **activate RustDesk Pro** through the desktop client API — not for normal staff who should use the web console.

---

If you try the Remote Operator + folder/user-group setup and something still feels off, tell us your exact goal (how many users, LDAP or local, need Web Client or desktop only?) and we’ll refine from there.
