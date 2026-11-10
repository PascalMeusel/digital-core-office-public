# Private migration staging

Only this README is public. Other files here are ignored by Git and mounted
read-only at `/migration` in Core. Database copies and account exports contain
personal data and password hashes. Restrict access and retain them only for the
documented migration/rollback period. Commands below run from `deploy` on Linux.

## Prepare the target and administrator

1. Retain the original application release, volumes, `.env`, and encryption keys.
   Take consistent snapshots of every source database and include attachments.
   Use the suite online backup where available; otherwise stop the application
   before copying its data directory. Copying live database and WAL files
   separately is not a consistent snapshot. Restore-test the copies.
2. Configure the new deployment and selected modules using the
   [deployment guide](../README.md). Keep ordinary users out during imports.
   Account import does not copy business records: restore verified product
   databases/media into separate new volumes, preserving original volumes.
3. If Time contains an active administrator, leave Core bootstrap values blank
   and import Time first. If importing only Inventory/Agile accounts, configure a
   separate Core bootstrap administrator with a distinct email and a temporary
   password of at least 14 characters before Core's database is first created.
   Product administrators become Core employees with their source product's admin
   role. Bootstrap only works while Core's user table is empty.

## Export encrypted Time accounts correctly

Run Time's exporter against a **working copy** of the verified snapshot, with the
original `DATA_ENCRYPTION_KEY` (Compose supplies `TIME_DATA_ENCRYPTION_KEY`). It
reads decrypted names/emails through Time's storage layer and preserves compatible
password hashes. Opening an older database can run migrations, so do not use the
only original snapshot. An encrypted SQLite file is not a usable account export
for Core.

Prepare `/secure/time-export-source/time-tracker.sqlite` from the verified snapshot
first. This bind mount replaces the one-off exporter's `/data`; the JSON goes into
the private exchange volume, while the target deployment's Time volume is untouched.

```bash
docker compose --env-file .env build time-tracking core-service
docker compose --env-file .env run --rm --no-deps \
  -v /secure/time-export-source:/data time-tracking \
  sh -c 'umask 077; npm run userbase:export -- /userbase/shared-userbase.json'
docker compose --env-file .env run --rm --no-deps core-service \
  npm run userbase:import-time -- /userbase/shared-userbase.json
```

An explicitly named one-off Time service can be used for migration even when Time
is not enabled in the final installation. Keep the final module/profile lists
unchanged. Verify the export count and readable names/emails, then record the
import count/checksum. Never post the export or password hashes to logs/tickets.

## Import other memberships before first login

Place consistent Inventory and Agile snapshots here as `inventory-system.sqlite`
and `agile-project.sqlite`. Run the applicable commands after the Time import and
**before any imported user signs in**:

```bash
docker compose --env-file .env run --rm --no-deps core-service \
  npm run userbase:import-inventory -- /migration/inventory-system.sqlite
docker compose --env-file .env run --rm --no-deps core-service \
  npm run userbase:import-agile -- /migration/agile-project.sqlite
```

| Source | Credentials and account role | Imported product access |
| --- | --- | --- |
| Time JSON | Preserves compatible Time hashes; Time administrators remain suite administrators | Time membership only |
| Inventory SQLite | Adds compatible module-only accounts as Core employees; keeps existing Core credentials | Inventory membership only, preserving its specialized role |
| Agile SQLite | Adds compatible module-only accounts as Core employees; keeps existing Core credentials | Agile membership only, preserving its supported role |

Supplemental imports can merge the source membership once into a matching,
still-unmanaged account. Inspect skipped-account counts and resolve ID/email
collisions or unsupported credentials explicitly. Repeated imports do not regrant
an already imported membership. The first successful Core session, password
change/reset, or manual Core account edit protects that account from later stale
imports. Additional access after that point must be assigned in Core.

## Verify and cut over

1. Record source counts and importer checksums; repeat imports before sign-in to
   verify stable results. Finish all source imports before login acceptance tests.
2. Sign in as the suite administrator, complete any forced password change, and
   review imported memberships in Core. Grant other enabled products and
   specialized roles deliberately; suite administration and product
   administration are separate responsibilities.
3. Test active/inactive accounts, existing passwords, forced password changes,
   viewer/employee/admin access, and next-request revocation. Open existing Time
   records, Inventory assignments/attachments, and Agile work/history. Profiles
   link lazily to Core; no routine password export into products is needed.
4. Recover older Agile browser-local work through its explicit administrator
   recovery flow, exporting the original before import. See
   [Agile recovery](../../agile-project-management-prototype/README.md#recover-browser-local-prototype-work).
   Account migration cannot transfer work stored only in a user's browser.
5. Start suite backups and complete an isolated restore test, then admit ordinary
   users. Suite mode already rejects module-local credentials and legacy sessions;
   deleting old password records is unnecessary and can impair rollback.

Remove protected exchange exports and staging copies after the documented
rollback/retention period. Keep original volumes, encryption keys, and the previous
release through acceptance. Never commit production data or account exports.
