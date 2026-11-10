# Self-host Digital Core Office

This is the supported company deployment: one HTTPS origin, Core for accounts and access, Caddy, and one to three selected product services. Commands below run from this `deploy` directory on a Linux Docker host. Use Docker Engine with Compose v2 and Node.js 24 for the host validation scripts.

## First installation

1. Point the installation's DNS name at the server and permit inbound TCP ports 80 and 443.
2. Copy `.env.example` to `.env` and restrict it to the operator (`chmod 600 .env`). Set `DCO_APP_HOST` and a matching `DCO_PUBLIC_BASE_URL`, such as `office.example.com` and `https://office.example.com`. The URL must be an origin without a subpath.
3. Set `DCO_ENABLED_MODULES` and `COMPOSE_PROFILES` to the same selected list in `time,inventory,agile` order. For example, an Inventory-only installation uses `inventory` in both fields. Do not add `backup` to these fields; select its separate profile when starting the backup service.
4. Generate independent secrets for `DCO_INTERNAL_AUTH_SECRET` and the compatibility setting `DIGITAL_OFFICE_SSO_SECRET` with `openssl rand -base64 32`. Suite requests use Core sessions; the compatibility SSO setting does not make old module sessions valid.
5. If Time is enabled, generate and securely retain `TIME_DATA_ENCRYPTION_KEY`. An existing Time database requires its original key. Keep `TIME_REQUIRE_DATA_ENCRYPTION=true` and `DCO_DISABLE_LOCAL_WEB_LOGIN=true`.
6. Set `DCO_TIMEZONE` to the installation's IANA timezone, for example `Europe/Berlin`. Compose passes it as both `DCO_TIMEZONE` and `TZ` to the product services.
7. Fill the installation-specific `DCO_OPERATOR_NAME`, `DCO_OPERATOR_ADDRESS`, `DCO_SUPPORT_EMAIL`, `DCO_PRIVACY_EMAIL`, and `DCO_PRIVACY_DETAILS`. These values populate public contact/privacy pages: use the actual operator's reviewed information and never put credentials in these fields. Quote values containing spaces or punctuation in `.env`.
8. For a fresh userbase, set `DCO_INITIAL_ADMIN_NAME`, `DCO_INITIAL_ADMIN_EMAIL`, and a unique `DCO_INITIAL_ADMIN_PASSWORD` of at least 14 characters. Core creates this administrator only while its user table is empty and requires a password change. For a migration with an active Time administrator, leave bootstrap values blank and import accounts first. If importing only Inventory/Agile accounts, bootstrap a distinct suite administrator before imports; product administrators do not receive suite account-management rights. Follow the migration procedure before opening the installation to users.
9. Configure the `DCO_SMTP_*` settings and test password-reset delivery. Place the license verification public key at the configured `DCO_LICENSE_PUBLIC_KEY_FILE` location; install the appropriate signed license as described below.

Validate without printing resolved secrets:

```bash
node scripts/validate-config.mjs .env
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

Compose uses `COMPOSE_PROFILES`; additional flags enabling every product are unnecessary. Disabled product services are not started, and Core rejects their routes and API access.

Open the public HTTPS URL, change the temporary administrator password, then sign in again. In Core's user management, create users, activate their product memberships, and assign the relevant product roles. Complete all migration imports before the first login: each importer grants only its source product membership. Inventory/Agile-only administrators become Core employees with their source product's admin role; imported Time administrators remain suite administrators. Review Inventory buyer, receiver, stock-manager, and viewer responsibilities explicitly. Check the license status and a permitted write in each enabled product. License restrictions and viewer roles are enforced at the API, even when a browser already has a workspace open.

Remove the bootstrap password from `.env` after successful setup and recreate Core with the updated environment. Keep `.env`, SMTP credentials, application encryption keys, signing material, and backup keys in protected operator storage. Do not attach `docker compose config` output to tickets: the expanded output contains secrets.

## Accounts and migration

Core is the live authority for identity, passwords, active state, sessions, module membership, and product roles. Enabled services verify Core on every request; revocation and membership changes take effect on the next request. Core unavailability fails closed. Legacy module tokens, copied password hashes, and the old SSO cookie do not bypass these checks.

Existing product data remains in its own database. Product profiles are created or refreshed on first authorized access, preserving an existing matching profile where possible. New company accounts are managed in Core; routine password synchronization or re-importing Core users into product databases is unnecessary. The Android client also uses the same Core account.

For an existing installation, follow [migration/README.md](migration/README.md). Export Time users using Time's own application with the original data-encryption key, then import the protected JSON into Core. Do not import an encrypted Time SQLite file directly: encrypted names and email addresses are not a usable account export. Inventory and Agile imports add their source memberships to matching, still-unmanaged accounts and create compatible module-only accounts. Complete all imports before users first sign in, then review memberships in Core. First sign-in and manual account changes make Core authoritative over later stale imports.

## Automatic encrypted suite backups

The `backup` profile runs a scheduler using the already-built Core image. It snapshots Core plus `DCO_ENABLED_MODULES`, includes nested product media/attachments, checks SQLite integrity, and writes an AES-256-GCM encrypted bundle with a checksum manifest. Backups use SQLite's online backup API, so committed WAL data is included without copying live database files. Each database is consistent individually; the module snapshots are independent, not one simultaneous transaction across all systems.

For a new backup setup, create directories and generate the backup key once:

```bash
install -d -m 700 secrets backups
test -e secrets/backup.key || (umask 077; openssl rand -base64 32 > secrets/backup.key)
```

Set `DCO_BACKUP_KEY_FILE`, `DCO_BACKUP_DIRECTORY`, `DCO_BACKUP_INTERVAL_HOURS` (default 24), and `DCO_BACKUP_RETAIN_DAYS` (default 30) in `.env`. The key must be outside application data and the backup directory. Keep an independently protected copy of the key; encrypted bundles cannot be restored without it. Ensure the product databases have initialized before starting the scheduler.

```bash
docker compose --env-file .env --profile backup up -d backup
docker compose --env-file .env --profile backup logs --tail=100 backup
docker compose --env-file .env --profile backup ps backup
```

The scheduler runs immediately, then at the configured interval. It retries failures after five minutes and reports unhealthy when its last run failed or is overdue. Monitor that health status externally. Retention removes old completed suite bundles only after a new backup succeeds. Copy completed encrypted bundles to independent storage; a backup directory on the same host does not survive loss of that host.

To run an additional backup immediately:

```bash
docker compose --env-file .env --profile backup run --rm --no-deps --entrypoint node backup \
  /app/deploy-scripts/backup-suite.mjs --data-root=/data --output=/backups \
  --key-file=/run/secrets/backup_key --retain-days=30
```

The backup container maps named volumes to `/data/core`, `/data/time`, `/data/inventory`, and `/data/agile`; only selected modules are required. Application configuration and encryption keys are excluded by default. Maintain `.env`, Time's data-encryption key, verification keys, and deployment overrides separately in protected recovery records. `--config-file /path/to/operator-config` can explicitly add a mounted configuration file to the encrypted bundle. Keep the backup's own decryption key separate in all cases.

For a host deployment with that same directory layout, `systemd/digital-core-office-suite-backup.service` and `.timer` are examples using Node 24. Adapt paths, enabled modules, and timer timezone before installation. Choose either that timer or the Compose scheduler for a given data directory. The existing Inventory timer remains available for standalone Inventory deployments.

## Restore to an isolated directory

Test this procedure before relying on backups. Restore using the corresponding reviewed application release and the original application data-encryption keys. Never copy SQLite files over a running service or restore into its current data directory.

1. Pick a completed bundle and a new verification directory. Replace the example bundle filename below with the actual filename. The destination must be absent or empty; the tool will not overwrite existing data.

```bash
install -d -m 700 /srv/dco-restore
docker compose --env-file .env --profile backup run --rm --no-deps \
  --entrypoint node -v /srv/dco-restore:/restore backup \
  /app/deploy-scripts/restore-suite.mjs \
  --bundle=/backups/suite-EXAMPLE.dco-backup --target=/restore/verified \
  --key-file=/run/secrets/backup_key
```

The tool authenticates/decrypts the bundle, checks paths, file checksums, and SQLite integrity, and publishes the restored directory only after verification. `restore-manifest.json` records the included modules. Confirm expected record counts and attachment files in this isolated copy. Preserve the encrypted original.

2. Restore the matching private configuration and application data-encryption keys. Stop the gateway, selected products, Core, and scheduled backup before replacing the deployment's volume mappings:

```bash
docker compose --env-file .env --profile backup stop
```

3. Copy each restored module into a **new** Docker volume. The following is the Core example; repeat with the corresponding source directory and a new volume name for every module listed in the manifest. The copy refuses nonempty destinations.

```bash
docker volume create dco-restored-core
docker run --rm --user 0:0 --entrypoint node \
  --mount type=bind,src=/srv/dco-restore/verified/core,dst=/source,readonly \
  --mount type=volume,src=dco-restored-core,dst=/destination \
  digital-core-office-core:YOUR_RELEASE_TAG \
  -e 'const fs=require("node:fs"); if(fs.readdirSync("/destination").length) throw new Error("Destination must be empty"); fs.cpSync("/source","/destination",{recursive:true,force:false,errorOnExist:true}); require("node:child_process").execFileSync("chown",["-R","1000:1000","/destination"]);'
```

| Manifest directory | Compose volume key | Example new volume |
| --- | --- | --- |
| `core` | `core_data` | `dco-restored-core` |
| `time` | `time_tracking_data` | `dco-restored-time` |
| `inventory` | `inventory_management_data` | `dco-restored-inventory` |
| `agile` | `agile_project_data` | `dco-restored-agile` |

4. Create a private `/srv/dco-restore/restore-volumes.yml` override for the restored modules. For example, a Core-and-Inventory backup uses:

```yaml
volumes:
  core_data:
    external: true
    name: dco-restored-core
  inventory_management_data:
    external: true
    name: dco-restored-inventory
```

Keep the original volumes unchanged for rollback. Confirm `DCO_ENABLED_MODULES`/`COMPOSE_PROFILES` matches the products restored or consciously configured separately. Start with the override and retain it for all subsequent operational commands:

```bash
docker compose --env-file .env -f compose.yml -f /srv/dco-restore/restore-volumes.yml config --quiet
docker compose --env-file .env -f compose.yml -f /srv/dco-restore/restore-volumes.yml up -d --force-recreate
```

5. Verify HTTPS health, existing user logins and memberships, Time's encrypted records, Inventory counts and delivery-note downloads, and Agile work/history. Re-enable the backup scheduler with the same override after acceptance. A rollback requires stopping the restored services, selecting the original volume mappings and compatible images, and accounting for any writes accepted after restoration.

Standalone Inventory's older encrypted bundles are still supported by its `inventory:restore` command. Its `--database` must point into a new empty parent directory, with media inside that directory. In-place `--force` restoration is intentionally rejected.

## Change modules and upgrade

Back up Core and all currently enabled products first. Set `DCO_ENABLED_MODULES` and `COMPOSE_PROFILES` to the same canonical module list, validate, and run `docker compose --env-file .env up -d --build --remove-orphans` (including any existing volume override). Recreate the backup service with `--profile backup` so it receives the new module selection. Product deactivation retains its database volume; archive it separately if it is no longer part of scheduled backups.

Before an upgrade, retain a tested backup, private configuration, the prior images/release, and original volume mappings. Deploy the reviewed release, check health and representative workflows, and retain the rollback source through acceptance. Do not use `docker compose down -v` as an upgrade or rollback step: it deletes named volumes.

## Private inventory and licenses

Company documents, photographs, floor plans, reference inventory JSON, production databases, license agreements, and private signing keys are private operator inputs. Mount private reference assets explicitly and configure `INVENTORY_REFERENCE_DATA_FILE` when required; an environment path alone does not mount a host file. Include separately mounted private assets in the operator's recovery plan if they are outside the backed-up product data volumes.

Install only the license verification public key on the server. To install a signed license, place its `.license` artifact in the ignored `migration` staging directory, then run:

```bash
docker compose --env-file .env run --rm --no-deps core-service \
  npm run license:install -- /migration/customer.license
```

Verify the license status in Core and retain the original artifact in protected records. Remove the temporary staging copy after the migration/rollback policy allows. Never copy the private license-signing key into the repository, application image, or production server. Runtime validation and license installation do not constitute legal approval of an operator's terms or privacy text.
# Frontend asset verification

For the canonical suite deployment, build all four applications and run
`node scripts/verifySuiteAssets.mjs` from the repository root before rollout.
After rollout, run `node scripts/verifySuiteAssets.mjs https://your-suite-host`
against that same build. Both checks must pass: API health alone cannot detect
an HTML fallback being returned for a missing JavaScript or CSS file.

For installations with private inventory reference data, also run:

```sh
node scripts/verifyInventoryMedia.mjs https://your-suite-host /path/to/inventory-reference.json /path/to/static-media
```

This checks every referenced room plan and photo over HTTPS, including its image
content type and checksum. Store these files in `static-media` beside the Inventory
database, or set `INVENTORY_STATIC_MEDIA_DIR` to their persistent mounted directory.
The API serves them independently of `dist`; rebuilds must not depend on recreating
a media symlink inside the frontend build output. Missing images return 404 rather
than the application's HTML page. Keep the media directory in the backup scope.

## Container restrictions and existing volumes

Applications run as `node` (UID/GID 1000), with a read-only root filesystem, a limited temporary filesystem, no Linux capabilities, no privilege escalation, and per-container memory, CPU and process limits. The backup worker runs as root with only `DAC_OVERRIDE`, so it can read private keys/assets and write the operator-owned backup folder on Linux. Its application-data mounts remain read-only. Set `DCO_RELEASE_TAG` to a unique reviewed release identifier; preserve the previous images for rollback. Node and Caddy base images use verified digests.

Before upgrading an existing Docker installation, take and verify a backup, stop the application services, and assign ownership of each application data volume to UID/GID 1000 using a temporary trusted helper container. Keep its mount limited to that specific volume. Preserve restrictive file modes. Restart and check health before accepting work. The recovery drill exercises this ownership conversion on new volumes; the company systemd installation does not require this Docker conversion.

## Company-server operations

The systemd operation units check all four service health endpoints, daily backup freshness and job result, weekly restore verification, and available disk space. Set `DCO_ALERT_RECIPIENT` in a root-only `/etc/digital-core-office/operations.env`; SMTP settings are read from the existing protected Core environment. Mail is sent only when a failure state changes or recovers. Verify SMTP delivery configuration before enabling `digital-core-office-operations.timer`.

`digital-core-office-verify-backup.timer` restores the newest encrypted backup into a private temporary directory every week, verifies authentication, file checksums and SQLite integrity, then removes the temporary copy. It never replaces live data. Daily backups retain 30 days. These backups stay on the existing server; server or disk loss requires a separately preserved recovery copy and encryption key.

Run `node deploy/scripts/retain-releases.mjs --keep=5` for a dry run. `--apply=true` first archives obsolete source and lockfiles without generated dependencies/build output, verifies each archive can be read, then removes the obsolete release directory. Current, newest five, and releases still used by running processes are retained. Archives stay private on the same server.
