# Deploying on a plain Linux host with systemd

This guide runs the bot on a plain Linux host using `systemd`, without Docker or Railway.

## Prerequisites

- Node.js 18+ (and `npm`) available on the host.
- A clone of this repository, for example at `/opt/discord-bot`.
- Root or `sudo` access to install the unit file.

## 1. Create a dedicated user

Run the bot as an unprivileged system user that owns the code and data directories.

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin discord-bot
sudo mkdir -p /opt/discord-bot
sudo chown -R discord-bot:discord-bot /opt/discord-bot
```

## 2. Install dependencies and build

Install dependencies and create the compiled bundle. The unit file runs the build output at `dist/index.js`, not the TypeScript source via `tsx`.

```sh
cd /opt/discord-bot
sudo -u discord-bot npm ci
sudo -u discord-bot npm run build
sudo -u discord-bot test -f dist/index.js
```

## 3. Configure environment

Create an environment file readable only by the service user. The file is passed to systemd via `EnvironmentFile`.

```sh
sudo tee /etc/discord-bot.env
```

Example contents:

```ini
Discord_Token=your-token-here
# Optional: set to "json" for structured logs in journalctl
Log_Format=text
# Graceful shutdown budget in milliseconds. Keep TimeoutStopSec at least this large.
Shutdown_Timeout_MS=30000
```

Lock down permissions:

```sh
sudo chown discord-bot:discord-bot /etc/discord-bot.env
sudo chmod 640 /etc/discord-bot.env
```

See the repository readme and `src/config.ts` for the full set of supported environment variables.

## 4. Data directory permissions

The bot persists runtime state in its data directory:

- The cursor file tracks the last processed item so the bot can resume after a restart.
- The instance lock file (`src/instanceLock.ts`) prevents two processes from running at the same time.

Both files must be readable and writable by the service user. Create the directory and give ownership to `discord-bot`:

```sh
sudo mkdir -p /var/lib/discord-bot
sudo chown discord-bot:discord-bot /var/lib/discord-bot
sudo chmod 750 /var/lib/discord-bot
```

Point the bot at this directory via the appropriate environment variable (e.g. `DATA_DIR`) in `/etc/discord-bot.env`. If you prefer to keep state inside the repo checkout, ensure the corresponding directory is likewise owned by the service user.

The lock file is only meaningful while the process is running; if the bot crashes hard and leaves a stale lock behind, remove it as the service user:

```sh
sudo -u discord-bot rm -f /var/lib/discord-bot/*.lock
```

## 5. Install the systemd unit

Create `/etc/systemd/system/discord-bot.service`:

```ini
[Unit]
Description=Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=discord-bot
Group=discord-bot
WorkingDirectory=/opt/discord-bot
EnvironmentFile=/etc/discord-bot.env
ExecStart=/usr/bin/env node dist/index.js
Restart=on-failure
RestartSec=5

# Send SIGTERM for a graceful shutdown.
Signal=SIGTERM
KillSignal=SIGTERM
# Must be larger than SHUTDOWN_TIMEOUT_MS so the app can finish cleanly
# before systemd sends SIGKILL.
KillMode=mixed
TimeoutStopSec=45

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The unit runs the build output at `dist/index.js` via `Node.js`. It does not invoke `tsx`, so make sure to run `npm run build` after every update.

TimeoutStopSec is set to 45 seconds, which is larger than the example `SHUTDOWN_TIMEOUT_MS=30000` (30 seconds). Adjust both values together: keep `TimeoutStopSec` at least a few seconds larger than `SHUTDOWN_TIMEOUT_MS` so the app has time to close connections and release the lock file before being force-killed.

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now discord-bot.service
sudo systemctl status discord-bot.service
```

## 6. View logs

Logs are captured by the journal. Use `journalctl` to follow or inspect them:

```sh
# Follow live logs
journalctl -u discord-bot -f

# Show the most recent 200 lines
journalctl -u discord-bot -n 200

# Logs since the last boot
journalctl -u discord-bot -b

# Logs within a time window
journalctl -u discord-bot --since "2024-01-01 12:00:00" --until "2024-01-01 13:00:00"
## Structured (JSON) logs

Set `LOG_FORMAT=json` in `/etc/discord-bot.env` to emit one JSON object per line. This is useful when forwarding journal output to a log aggregator or querying it with `jq:

```sh
journalctl -u discord-bot -o cat | jq -c '.MESSAGE'
```

After changing `LOG_FORMAT`, restart the service so the new format takes effect:

```sh
sudo systemctl restart discord-bot.service
```

## 7. Updating the bot

```sh
cd /opt/discord-bot
sudo -u discord-bot git pull --ff-only
sudo -u discord-bot npm ci
sudo -u discord-bot npmr run build
sudo systemctl restart discord-bot.service
```

The service will receive `SIGTERM`, shut down gracefully within `SHUTDOWN_TIMEOUT_MS`, and release the instance lock before the new process starts.
