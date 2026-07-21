# Temporal (local + EC2)

## Local

```bash
cp .env.example .env   # first time only
docker compose up -d
```

- Server: `localhost:7233`
- Web UI: `http://localhost:8080`
- Postgres data persists in the `temporal-postgresql-data` volume across restarts.

## Deploying to EC2

1. Copy this folder to the instance and run `cp .env.example .env`.
2. In `.env`, set a real `POSTGRES_PASSWORD` and set `TEMPORAL_CORS_ORIGINS` to the domain/IP the UI will be accessed from.
3. `docker compose up -d` — all services use `restart: unless-stopped`, so they come back up after an instance reboot.
4. Restrict the security group: only open 7233 to workers/services that need to talk to Temporal, and 8080 only if you need remote UI access (otherwise reach it over an SSH tunnel).
