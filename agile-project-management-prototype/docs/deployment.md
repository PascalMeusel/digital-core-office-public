# Agile Project Management Deployment

This deploys the Agile Project Management prototype as a real Digital Core Office service: Docker builds the app, the Node server provides authentication and static assets, Caddy terminates HTTPS, and SQLite data lives in a named Docker volume.

## Single-System Deployment

Use this when Agile Project Management is the only Digital Core Office system binding ports 80 and 443 on the server.

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker up -d --build
```

Production shape:

- Caddy listens on host ports `80` and `443`.
- Express listens inside Docker on port `4197`.
- SQLite lives at `/data/agile-project.sqlite` inside the container volume.
- `APP_HOST` is required for Caddy.
- The preferred login source is a shared userbase import from Time Tracking.

## Shared Userbase Import

Import the shared userbase after the Time Tracking export exists:

```bash
docker compose --env-file .env.docker run --rm app npm run userbase:import -- /userbase/shared-userbase.json
```

The shared userbase file contains password hashes and should be handled as secret material. Delete it after all imports are complete.

## Same Server As Other Digital Core Office Systems

If all three systems run on the same server, prefer the root deployment in `../deploy`. It uses one Caddy container for Time Tracking, Inventory Management, and Agile Project Management.
