# Digital Core Office Core

Core owns accounts, passwords/reset mail, sessions, module memberships, product
roles, the application shell, operator pages, and licenses. Business data remains
in the separate Time, Inventory, and Agile databases. Modules verify Core on every
request through the server-only `packages/core-client` adapter. Revocation and
permission changes apply on the next request; Core unavailability fails closed.
Browser sessions use an HttpOnly Core cookie. Old module credentials and SSO
cookies do not grant suite access.

In the Android app, signed-in users have a fixed bottom-right QR action for
signing in on another computer. The shell uses the existing native scanner and
shows an explicit account confirmation. The authenticated
`POST /api/core/auth/qr-login/challenges/approve` endpoint checks the current
identity against `expectedUserId` and authorizes only a valid challenge from
this server. Inventory membership is unnecessary. Desktop QR creation/claim
and expiration remain unchanged. Browser coverage is available with
`node --import tsx tests/device-sign-in.browser.test.mjs`; it uses an isolated
real Core API and supplies scanner results at the native bridge boundary.

## Development

Use Node.js 24 and install from this directory:

```bash
npm ci
npm run dev
```

The API runs on port 4167 and Vite on 5176. Configure `DCO_PUBLIC_BASE_URL`,
`DCO_ENABLED_MODULES`, internal authentication, and a private `DCO_CORE_DATA` path
for the intended environment. For an empty database set
`DCO_INITIAL_ADMIN_NAME`, `DCO_INITIAL_ADMIN_EMAIL`, and
`DCO_INITIAL_ADMIN_PASSWORD` (at least 14 characters) before first start. Bootstrap
runs only when the user table is empty and requires a password change. Never use
production data/keys for local tests.

Run `npm test`, `npm run lint`, and `npm run build` for verification. The supported
company installation and encrypted backup/restore procedure are in
[deploy/README.md](../deploy/README.md).

## Account migration

Export Time users through Time's application using the original data-encryption
key. Import that protected JSON, then Inventory/Agile source memberships, before
imported users first sign in:

```bash
npm run userbase:import-time -- /secure/shared-userbase.json
npm run userbase:import-inventory -- /secure/inventory-system.sqlite
npm run userbase:import-agile -- /secure/agile-project.sqlite
```

Use applicable sources and consistent database copies. An encrypted Time SQLite
file is not a substitute for the decrypted account export. That JSON contains
personal data/password hashes; restrict access and its retention. Importers
preserve compatible hashes and print verification counts/checksums. Each grants
only its source product membership.

Inventory/Agile imports retain matching Core credentials and merge a source
membership once while the account is unmanaged. New module administrators receive
their product admin role, not suite account-management rights. Time administrator
imports or a separate fresh Core bootstrap supply the initial suite administrator.
First Core sign-in or manual account/password changes protect an account from
later stale imports. Finish all imports before login testing, then review access
in Core. Local profiles are provisioned on authorized access; routine password
synchronization into products is unnecessary. See the
[migration procedure](../deploy/migration/README.md) for safe commands and rollback.

## Production configuration

- `DCO_ENABLED_MODULES`: one to three values from `time,inventory,agile`, matching
  the deployment's product Compose profiles.
- `DCO_PUBLIC_BASE_URL`: the single public HTTPS origin.
- `DCO_INTERNAL_AUTH_SECRET`: a generated secret shared with trusted services over
  the private network. Internal API routes are not published by the gateway.
- `DIGITAL_OFFICE_SSO_SECRET`: retained compatibility setting; suite access remains
  subject to current Core sessions and memberships.
- `DCO_TIMEZONE`/`TZ`: the installation's IANA timezone.
- `DCO_OPERATOR_NAME`, `DCO_OPERATOR_ADDRESS`, `DCO_SUPPORT_EMAIL`,
  `DCO_PRIVACY_EMAIL`, `DCO_PRIVACY_DETAILS`: reviewed public operator contact and
  privacy information; these fields must not contain secrets.
- `SMTP_*`: password-reset delivery (configured as `DCO_SMTP_*` in suite `.env`).
  Verify delivery before inviting users.
- `DCO_LICENSE_PUBLIC_KEY_FILE`: verification public key for signed offline suite
  licenses. Keep private signing keys and customer contracts outside the server,
  repository, and deployment image.

Back up Core with the selected products/media. Keep `.env`, original application
data-encryption keys, and the backup key separately in protected recovery records.
License checks and operator page configuration do not establish legal approval of
the deployment or its terms.
