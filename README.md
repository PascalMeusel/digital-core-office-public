# Digital Core Office

Digital Core Office is a self-hosted business suite with one runtime, one account
authority, and three independently selectable systems:

- Time Tracking
- Inventory Management
- Agile Project Management

The suite is served from one HTTPS origin. The Core service owns the persistent
application shell, login, password reset, sessions, module access, and licensing.
Enabled systems load as same-origin workspaces below the stable suite header, so
switching products replaces only the work area and keeps browser history working.
Business data remains in separate SQLite databases so each system can evolve and
be backed up independently.

## Architecture

```text
browser -> Caddy -> Core shell and authentication
                       -> /time/index.html      (optional workspace)
                       -> /inventory/index.html (optional workspace)
                       -> /agile/index.html     (optional workspace)
```

`DCO_ENABLED_MODULES` and matching Docker Compose profiles activate any valid
combination of one, two, or three systems. Disabled systems are neither started nor
routable. The fixed Compose project name prevents accidental duplicate production
stacks on the same Docker host.

All enabled UIs consume the Time Tracking-derived design tokens and responsive
header from `packages/suite-ui`. The product icon, accent, and local navigation
change per system while the header geometry, system switcher, language, theme, and
account controls remain stable. Only enabled modules are advertised. Local web
login is disabled in the recommended deployment so the Core database is the sole
account authority.

## Self-hosting

Requirements: Docker Engine with Compose v2, Node.js 24 for validation, a DNS name
pointing to the server, and inbound ports 80/443.

```bash
cd deploy
cp .env.example .env
# Set the URL, matching module/profile lists, operator contacts, timezone,
# generated secrets, and a fresh-install Core administrator in .env.
chmod 600 .env
node scripts/validate-config.mjs .env
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

`COMPOSE_PROFILES` must match `DCO_ENABLED_MODULES`; Compose reads it automatically.
Fresh installations require a Core bootstrap account and an initial password change.
Configure the separate `backup` profile for encrypted scheduled snapshots of Core,
selected products, and attachments. Keep decryption keys and private configuration
separately and test restoration into an isolated directory.
The complete installation, migration, backup, restore, module-change, and upgrade procedure is in
[deploy/README.md](deploy/README.md).

## Android application

`android-app` contains the single Android client for all enabled modules. Users enter
their organization’s HTTPS server once; the app validates compatibility, shares the
Core login across Time Tracking, Inventory, and Projects, and provides a native QR
scanner without requesting camera permission. See `android-app/README.md` for the
security model, build, signing, App Links, and release process.

## Migrating existing accounts

Export Time accounts through Time's application using its original data-encryption
key, then import the protected JSON into Core. Do not import an encrypted Time
SQLite file directly. Import Inventory and Agile accounts from consistent database
copies, completing all source imports before users first sign in. Compatible
password hashes remain usable; import checksums support verification.

Each source grants only its own product membership. Review roles and additional
access in Core after migration. The first Core session or account edit protects
that account from later stale imports. Product profiles link on first authorized
access, preserving existing business data and profile IDs where matched. In suite
mode, Core checks every request; module passwords and old sessions cannot bypass
Core revocation or access decisions. Follow [deploy/migration/README.md](deploy/migration/README.md)
for the administrator bootstrap, encrypted Time export, and rollback procedure.

## Time-quality suggestions

Time Tracking now shows “Days needing attention” on the dashboard. It detects
missing or open entries, invalid/overlapping entries, implausible zero-duration
records, schedule variance, break and rest issues, long days, Sundays/holidays, and
the rolling 24-week average. Findings are advisory data and policy checks—not
automatic legal decisions. Suggested actions prefill a correction or absence
request; they never silently rewrite a time record.

## Development and verification

Install from an application directory as usual; the local `packages/suite-ui`
dependency is resolved from the repository root. For example:

```bash
cd time-tracking-system
npm ci
npm run dev
```

Core has tests for account authority, import, licensing, and module combinations.
Time tests cover accounting integrity and day-quality suggestions; Inventory tests
cover receiving, assignments, journal exports, and authentication; Agile tests cover
persistence, concurrent edits, permissions, and migration. Backup tests restore
SQLite snapshots and attachments from authenticated encrypted bundles. CI builds
and lints every application and expands all seven valid deployment combinations.
The cross-system suite test builds all four applications behind one local origin
and verifies one-login navigation, shared preferences, and the mobile shell:

```bash
cd time-tracking-system
npm run test:suite
```

## Licensing and legal status

The repository license is a German-law source-available license with a German
authoritative text and English convenience translation: [LICENSE.md](LICENSE.md).
It includes explicit self-hosting rights, an active-user definition, liability
carve-outs required by mandatory German law, and separate rules for businesses and
consumers.

It is intentionally marked as a legal-review draft. “Legally valid in Germany”
cannot responsibly be guaranteed by software changes alone; German counsel must
approve the final text before public publication. The review record is
[legal/GERMAN_COUNSEL_REVIEW_CHECKLIST.md](legal/GERMAN_COUNSEL_REVIEW_CHECKLIST.md).
Customer-specific special grants are generated privately under `deploy/private-licenses/`
and are excluded from version control and public exports.

## Preparing a distributable source snapshot

The export command copies only release-safe files into a new directory, scans for
common embedded secrets, excludes private customer/reference material, and can
initialize a clean Git history:

```bash
node scripts/preparePublicRelease.mjs ../digital-core-office-public --init-git
```

Review the staged tree and the legal checklist before distributing a release.
The security contact is recorded in [SECURITY.md](SECURITY.md).
No Git remote or GitHub credentials are required for local development.

## Data protection

Employee, inventory, planning, audit, SMTP, encryption, and backup data are
confidential. Operators must configure HTTPS, access controls, retention/deletion,
backup restore tests, secret rotation, and any required employee-representation or
data-protection review. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
dependency notices.

## Source snapshot and sample configuration

This repository contains the distributable source snapshot, with synthetic test
identities and example domains. Runtime databases, employee records, customer
inventory and plans, attachments, credentials, signing keys, deployment incidents,
and store-account records are excluded. Configure your own installation using the
example environment files. No preconfigured company installation is included.

The experimental Zeitguru adapter remains disabled by default. Its sample
origin and email-domain restrictions use `office.example.test` and `example.test`;
they are not live service settings. The provider API key is a placeholder and the
tenant hash is synthetic. Review the integration and explicitly configure the origin,
email domain, tenant pin and provider public API key before any authorized evaluation. The existing license remains
a legal-review draft; this source upload is not a production release.
