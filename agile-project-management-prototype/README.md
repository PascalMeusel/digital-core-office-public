# Digital Core Office Agile

Shared project work, sprint boards, stakeholders and decisions for a Digital Core Office installation.

```bash
npm ci
npm run dev
```

The app runs on `http://localhost:5175` and uses the API at `http://localhost:4197`. Workspace data and its change history are stored in the same SQLite database as Agile profiles (`AGILE_PROJECT_DATA`). New installations start with an empty workspace. Use the suite's online SQLite backup for a consistent snapshot including committed WAL data; copying a running database and WAL separately is unsafe. Restore into an isolated directory before switching stopped services to new volumes.

In suite mode (`DCO_CORE_URL`), Core verifies every request and is the only credential/session authority. New Core accounts receive local Agile profiles on first access. Revocation and membership changes apply on the next request; legacy module tokens and SSO cookies are not accepted. Employees can create and update work items and propose decisions. Agile administrators can approve/reject decisions and import workspaces. Viewer memberships and a read-only suite license permit reading/exporting only. The role lens changes the view; it does not grant permissions.

Updates use atomic version checks, so an old browser cannot silently overwrite a colleague's change. A conflict loads the current workspace and retains the pending change for explicit retry or export. Request IDs prevent duplicate writes after lost responses. Every accepted change records its server-verified actor, timestamp, operation, and complete before/after snapshots. The UI and JSON export expose the most recent 100 audit summaries; the database retains the full history.

## Recover browser-local prototype work

Old browser work is never loaded or copied automatically, and the old local-storage entry is not deleted or overwritten. After signing in as an Agile administrator, open **Recover an older browser workspace**. Confirm you created the workspace or are authorized to recover it. **Export original copy** downloads the original JSON bytes. **Back up and import into shared workspace** downloads that same backup before requesting an import. Imported work becomes visible to authorized users of this installation.

You can also import an exported JSON file. Imports validate every field, merge new records, and skip identical records. Different records with the same ID, incompatible workspace settings, unsupported fields, and malformed files cause the entire import to fail without changing server data. Keep the original export and resolve conflicting records in a separate copy before retrying. No browser copy is treated as belonging to whichever account signs in next.

Run `npm test` for persistence/restart, account authority, permissions, conflict handling, idempotency, and lossless migration tests; `npm run build` checks the application and server TypeScript before building the browser assets.

For a standalone local database, set `AGILE_INITIAL_ADMIN_NAME`, `AGILE_INITIAL_ADMIN_EMAIL`, and `AGILE_INITIAL_ADMIN_PASSWORD` before the first `npm run dev`. Company deployments should use Core-managed accounts through the root deployment instead of creating a separate Agile-only account.

## Legacy standalone userbase import

For standalone compatibility, Agile can import a protected userbase exported from
Time Tracking. This is not the suite migration or ongoing account-management flow;
suite deployments import source accounts into Core and link profiles on access.

```bash
npm run userbase:import -- ../shared-userbase.json
```

Imported users keep their existing passwords. The shared userbase file contains password hashes and should be treated as secret material.

## Deployment

Use the supported [suite deployment guide](../deploy/README.md), including for an
Agile-only company installation. It configures Core accounts, HTTPS, selected
products, timezone, and encrypted backups.
