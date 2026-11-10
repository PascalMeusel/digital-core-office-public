# Time Tracking

Independent Digital Core Office time tracking system.

It contains the React time tracking frontend, Express API, SQLite persistence, calendar features, approvals, CSV import/export, mail settings, holidays, and local backup support.

## Local Development

```bash
npm ci
npm run dev
```

- Web app: `http://localhost:5173`
- API health: `http://localhost:4177/api/health`

Copy `.env.example` to `.env` when local configuration is needed.

## Deployment

Use the supported [suite deployment guide](../deploy/README.md), including for a
Time-only company installation. It configures Core accounts, HTTPS, selected
products, encryption, and scheduled backups. Restore suite snapshots into a new
isolated directory before switching stopped services to new volumes. Preserve
the original Time data-encryption key separately from the backup decryption key.

Set `DCO_TIMEZONE` to the organization's IANA timezone (default `Europe/Berlin`).
Calendar dates, corrections and exports use this timezone; browsers receive the
same setting. Nonexistent times during a daylight-saving transition are rejected.

With `DCO_CORE_URL` configured, Core owns accounts, passwords, sessions, module
permissions and licenses. Local Time profiles are linked on first access without
changing historical employee IDs; employment terms and balances remain in Time.

## Existing accounting data

New corrections replace the affected day's entries and preserve originals in the
encrypted audit history for undo. New overtime approvals record dated deductions;
undo reverses those deductions. Historical approvals are not silently reapplied,
because existing manual adjustments or payroll may already have settled them.
Before using an upgraded database for payroll, run:

```bash
node --import tsx scripts/reportLegacyAccounting.ts
```

Use the deployment's data path and encryption key. Review the report against
payroll, then undo/recreate verified unsettled approvals and reconcile manual
adjustments explicitly. Also review existing overlapping time entries in the day
issues screen. The balance panel flags legacy overtime approvals awaiting review.

Weekly backups use SQLite's online backup API and publish the complete snapshot
once per ISO week, including committed WAL data. Existing backups are retained.

## Contents

- `src/`: Time tracking UI.
- `server/`: Time tracking API and persistence.
- `shared/`: Shared date, domain, and employment-term helpers.
- `tests/`: Playwright browser smoke test.
- `scripts/start-playwright-server.mjs`: Test helper that starts a clean local test instance.
