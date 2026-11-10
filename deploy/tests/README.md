# Deployment checks

Use Node 24. The configuration tests validate every supported module combination;
set `DCO_TEST_DOCKER_CONFIG=true` to also parse each with Docker Compose:

```sh
node --test scripts/tests/*.test.mjs deploy/tests/*.test.mjs
```

The production smoke runs the production service definitions and Caddyfile with
fresh, uniquely named Docker volumes, synthetic operator details, random secrets,
and a loopback HTTP gateway. No operator data or private license files are mounted.
It checks all seven module combinations, forced password changes, lazy profiles,
permissions, licensing read-only behavior with exports, and immediate offboarding:

```sh
node deploy/tests/production-smoke.mjs --build-images
```

The all-module configuration also runs `backup-recovery-smoke.mjs` before cleanup:
the actual scheduled backup snapshots the named volumes, then a separate restored
stack must start without bootstrap credentials and preserve the Core login,
module records, and nested attachment bytes. This recovery check also runs in CI.

Select one combination using `--modules=time,inventory,agile` or `DCO_SMOKE_MODULES`.
Without `--build-images`, it uses existing `dco-launch-audit-{core,time,inventory,agile}:local`
images. Set `DOCKER_CONTEXT` if a specific Docker context is required. CI builds
each selected configuration independently.

For a follow-up backup drill, combine one explicit `--modules` selection with
`--keep-project`. On success, the script prints the generated project name,
Compose file, environment file, and loopback URL. It retains only that synthetic
project; the backup profile points at temporary backup/key files. Failed tests
always clean up. Remove a retained project afterward with `docker compose -p`
using the exact printed project name, `--env-file` and `-f` paths, followed by
`down --volumes --remove-orphans`. Never substitute a production project name.
