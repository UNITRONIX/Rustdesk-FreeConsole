# Reply for GitHub discussion #285 (posted)

Posted: https://github.com/UNITRONIX/BetterDesk/discussions/285#discussioncomment-17865636

---

Thanks for the detailed write-up — and thanks @noelhibbard for chiming in. This is expected today, not a broken install.

BetterDesk login + user/device groups control **who can see which machines** (address book / ACL) and how sessions show up in audit. They do **not** replace the **RustDesk peer password** on the target. That handshake is between the two RustDesk clients over the relay; the BetterDesk API does not skip it.

So: AB updating correctly means group scoping is working. The password prompt on connect is the target’s permanent/temporary password (or approve mode), not your BetterDesk account password.

For unattended access without someone clicking Accept every time, set a **permanent password on each target** during deploy (e.g. `rustdesk.exe --password '…'` / client Security settings) and give that peer password to authorized operators. Panel Access Policy can store a copy for inventory/reference; it does not remotely reconfigure stock RustDesk or enable passwordless peer login from API identity alone.

We do not currently offer “passwordless RD to targets via API” based on BetterDesk user membership. If that is a feature you need (server-enforced connect grants / shared peer secret per group), say so and we can track it as a product request — it would be new work, not a config fix.

Docs clarification (two auth layers / Access Policy vs peer password) is landing on `dev` shortly.
