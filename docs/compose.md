# Mock stack via Docker Compose

This guide explains how to bring up the mock Stellar RPC and the bot together using `docker-compose.mock.yml`. It is intended for local demos and development only — no real token or Telegram credentials are required.

## Prerequisites

- Docker Engine 20.10+ with the Compose v2 plugin (`docker compose`)
- The repository checked out locally

## QuickStart

From the repository root:

```bash
docker compose -f docker-compose.mock.yml up
bash
```

This starts two services:

| Service    | Description                                                     |
|------------|-------------------------------------------------------------------------|
| `mock-rpc` | Mock Stellar RPC server (`npm run mock:rpc`) exposed on host port `8000`. |
| `bot`      | The bot running with `MIMIR_PROFILE=mock` and `STELLAR_RPC_URL` pointed at the mock RPC. |

The bot waits for the mock RPC to report healthy before starting.

## Configuration

The compose file sets the following environment variables for the `bot` service:

- `MIMIR_PROFILE=mock` — uses mock profile settings (dry-run behaviour, no real Token).
- `STELLAR_RPC_URL=http://mock-rpc:8000` — points the bot at the mock RPC service.
- `TELEGRAM_BOT_TOKEN=`${TELEGRAM_BOT_TOKEN:-}` — optional; leave unset to run with the fake Telegram client when available.

Override any of these by exporting them in your shell or via an `.env` file before running compose.

## Data Persistence

Bot state is stored in the `mock-data` named volume, mounted at `/app/data`. This means data survives `container restarts and `docker compose down`.

To reset state completely:

```bash
docker compose -f docker-compose.mock.yml down -v

```

## Security

Both services run as a non-root user, matching the production `Dockerfile`. Do not run the mock stack in production.

## Common Commands

```bash
# Start in the background
docker compose -f docker-compose.mock.yml up -d

# Stream logs
docker compose -f docker-compose.mock.yml logs -f

# Stop and remove containers
docker compose -f docker-compose.mock.yml down

# Rebuild images after code changes
docker compose -f docker-compose.mock.yml up --build
```

## Troubleshooting

- Port `8000` already in use: stop the conflicting process or change the published port in `docker-compose.mock.yml`.
- Bot exits immediately: check `mock-rpc` health with `docker compose -f docker-compose.mock.yml ps `.
- Stale data: remove the `mock-data` volume with `docker compose -f docker-compose.mock.yml down -v`.
