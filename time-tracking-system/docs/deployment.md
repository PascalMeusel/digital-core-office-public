# Time Tracking Deployment

This is the copied and adapted deployment model from the previous server setup: Docker Compose builds the app container, Caddy terminates HTTPS, and SQLite data plus backups live in a named Docker volume.

## Single-System Deployment

Use this when Time Tracking is the only Digital Core Office system binding ports 80 and 443 on the server.

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker up -d --build
```

Production shape:

- Caddy listens on host ports `80` and `443`.
- Express listens inside Docker on port `4177`.
- SQLite lives at `/data/time-tracker.sqlite` inside the container volume.
- Backups live at `/data/backups`.
- `APP_BASE_URL`, `APP_HOST`, and `DATA_ENCRYPTION_KEY` are required.
- Initial admin variables are only needed for the first start with an empty database.

## Same Server As Other Digital Core Office Systems

If multiple Digital Core Office systems run on the same server, prefer the root deployment in `../deploy`. It uses one Caddy container for all apps, avoiding port conflicts.

## Shared Userbase Export

Time Tracking is the source for the shared Digital Core Office userbase during this deployment phase.

```bash
docker compose --env-file .env.docker run --rm app npm run userbase:export -- /userbase/shared-userbase.json
```

The exported file contains password hashes. Treat it as secret material and delete it after importing it into the other systems.

## Do Not Destroy The Previous Deployment

- Do not run `docker compose down -v` against the old deployment unless you intentionally want to delete its Docker volumes.
- Use a new checkout path and the `digital-core-office-time-tracking` compose project name.
- Use fresh named volumes unless you are doing a deliberate database migration.
- Test with a new hostname first, or stop the old Caddy only during the final cutover.
