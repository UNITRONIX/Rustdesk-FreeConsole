# SQLite authentication-store consolidation

BetterDesk versions before the consolidation maintain two SQLite files:

- `db_v2.sqlite3` — BetterDesk server data;
- `auth.db` — legacy Node.js panel users, MFA, tokens and panel state.

The current runtime uses one selected database. On SQLite this is
`db_v2.sqlite3`; on PostgreSQL no SQLite file is created.

## Upgrade an existing SQLite installation

Stop the BetterDesk server and console first. Do not run the migration while
either process may write to either database.

Run a validation-only pass:

```sh
AUTH_DB_PATH=/opt/BetterDeskConsole/data/auth.db \
  betterdesk-server -db /opt/rustdesk/db_v2.sqlite3 \
  -migrate-sqlite-auth -migrate-sqlite-auth-dry-run
```

If it completes without conflicts, run the migration with a durable backup
directory:

```sh
AUTH_DB_PATH=/opt/BetterDeskConsole/data/auth.db \
  betterdesk-server -db /opt/rustdesk/db_v2.sqlite3 \
  -migrate-sqlite-auth \
  -migrate-sqlite-auth-backup-dir /opt/rustdesk/backups
```

The command emits a JSON report. It:

1. validates both databases with SQLite integrity and foreign-key checks;
2. creates snapshots of both databases and a candidate copy of `db_v2.sqlite3`;
3. imports the legacy panel data only into the candidate;
4. aborts on user, role, credential, MFA, address-book or primary-key
   conflicts rather than silently overwriting data;
5. validates the candidate and atomically activates it.

The original `auth.db` is not changed or deleted. Keep it and the generated
backups until the upgraded service has been verified and the normal retention
period has elapsed.

## Verify and rollback

Start BetterDesk and confirm login, MFA, device groups, folders and the
RustDesk address book. The migration marker makes both the Go server and Node
console read panel data from `db_v2.sqlite3`.

If service verification fails before new data is written, stop services and
restore the reported target snapshot:

```sh
betterdesk-server -db /opt/rustdesk/db_v2.sqlite3 \
  -rollback-sqlite-auth /opt/rustdesk/backups/db_v2.sqlite3.pre-auth-consolidation-YYYYMMDDTHHMMSSZ
```

The failed consolidated database is retained alongside the active file for
forensics. Migration never deletes the legacy `auth.db`.
