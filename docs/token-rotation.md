# Operator Guide: Rotating the Bot Token

This guide details the procedure for safely rotating a leaked, compromised, or expiring Telegram bot token (`BOT_TOKEN`) with minimal service interruption for `@mimir-stellar/telegram-bot`.

---

## 1. Operating Principles & Architecture

* **Read-Only Operation:** The notifier strictly reads event streams from the Stellar blockchain and dispatches messages to Telegram. It holds no blockchain signing keys or private transaction credentials.
* **Token Configuration:** The Telegram authentication token is loaded on startup from the `BOT_TOKEN` environment variable in `src/config.ts`.
* **Centralized Redaction:** At boot, `BOT_TOKEN` is automatically registered with `registerSecrets()` in `src/redact.ts`, and `Logger.configure()` installs redaction masks. All operator-facing outputs (logs, `/status` snapshots, and `GET /health` responses) redact the token string and BotFather token patterns (`\b\d{9,10}:[A-Za-z0-9_-]{35,}\b`) to `[REDACTED]`.
* **Single Active Token Invalidation:** Telegram bot tokens are strictly 1-to-1 with a bot identity. When a token is revoked via [@BotFather](https://t.me/BotFather), Telegram invalidates the old token immediately upon issuing the new one. Two different tokens cannot be active simultaneously for the same bot username.
* **Downtime Minimization:** Because token invalidation is instantaneous on Telegram's side, downtime is bounded by the speed of updating the process environment and restarting the daemon (typically a few seconds). Cursor state persisted in `CURSOR_FILE` guarantees that no on-chain events are skipped or double-notified during the restart.

---

## 2. When to Rotate a Token

1. **Suspected Leak or Compromise (Urgent):**
   * Token was inadvertently committed to version control, pasted in public chat rooms, tickets, or exposed in unredacted third-party logs.
   * Unauthorized messages or unknown webhook destinations observed on the bot.
   * Action: Revoke immediately via BotFather, then follow the rotation and cleanup steps below.
2. **Routine Credential Hygiene (Scheduled):**
   * Scheduled rotation intervals or team member offboarding.
   * Action: Stage configuration ahead of time to minimize downtime to a brief process restart.

---

## 3. Pre-Rotation Preparation

Before revoking the token, gather necessary access and identify your deployment mode:

1. **Access to BotFather:** Ensure access to the Telegram account that owns the bot via [@BotFather](https://t.me/BotFather).
2. **Determine Operating Mode:**
   * **Long-Polling Mode (default):** `TELEGRAM_WEBHOOK_URL` is unset or empty in configuration. The bot pulls updates directly via Telegram's `getUpdates` API.
   * **Webhook Mode:** `TELEGRAM_WEBHOOK_URL` is set to an external HTTPS URL (e.g. `https://bot.example.com`). Telegram pushes updates via HTTP POST to `/telegram-webhook`.
3. **Locate Environment Configuration:**
   * Local or Bare-Metal: `.env` file in the project root.
   * Docker / Docker Compose: Environment section or `.env` referenced by `docker-compose.yml`.
   * Systemd: `/etc/systemd/system/mimir-telegram-bot.service` or associated environment file.
   * Cloud / Kubernetes: Secret store or environment variable configuration manager.
4. **Baseline Health Check:** Verify the bot is currently healthy before starting rotation:
   ```bash
   curl -s http://127.0.0.1:8787/health | jq .ok
   ```

---

## 4. Step-by-Step Rotation Procedures

### Procedure A: Long-Polling Mode (Default)

Follow these ordered steps when the bot runs in long-polling mode:

#### Step 1: Pre-stage the Configuration
Open your deployment's secret configuration (e.g., `.env`) in an editor or prepare your container secret update command so you can apply the new token without delay once issued.

#### Step 2: Revoke the Old Token & Generate a New Token
1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send:
   ```text
   /mybots
   ```
3. Select your bot from the list.
4. Choose **API Token**.
5. Select **Revoke current token** (or send `/revoke`).
6. BotFather immediately invalidates the previous token and replies with the new token:
   ```text
   Your token has been revoked. Here is your new token:
   <NEW_BOT_TOKEN>
   ```
7. Copy the new token securely.

#### Step 3: Update `BOT_TOKEN` in Configuration
Update `BOT_TOKEN` in `.env` or your deployment environment:

```env
BOT_TOKEN=<NEW_BOT_TOKEN>
```

#### Step 4: Restart the Bot Daemon
Trigger a graceful restart of the bot process:

* **Systemd:**
  ```bash
  sudo systemctl restart mimir-telegram-bot
  ```
* **Docker Compose:**
  ```bash
  docker compose restart mimir-telegram-bot
  ```
* **Node process / NPM:**
  Send `SIGINT` (Ctrl+C) or `SIGTERM` to the process, then run:
  ```bash
  npm run start
  ```

**What happens during restart:**
1. **Graceful Drain:** On receiving `SIGTERM` or `SIGINT`, the process waits for any in-flight Stellar polling cycle to finish, flushes the latest cursor position to `CURSOR_FILE` (ensuring no duplicate or lost event alerts), and closes cleanly.
2. **Fresh Boot:** The new process validates configuration via `loadConfig()`, registers `<NEW_BOT_TOKEN>` with `registerSecrets()`, and establishes a long-polling session with Telegram using `bot.start()`.

---

### Procedure B: Webhook Mode

In webhook mode (`TELEGRAM_WEBHOOK_URL` is set), Telegram delivers updates to `/telegram-webhook`. In `src/index.ts`, each process boot generates a fresh 32-byte secret (`webhookSecret = randomBytes(32).toString("hex")`) and re-registers the webhook URL with Telegram via `bot.api.setWebhook()`.

#### Step 1: Pre-stage the Configuration
Verify the public hostname in `TELEGRAM_WEBHOOK_URL` remains reachable and prepare your configuration update.

#### Step 2: Revoke the Old Token on BotFather
1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/mybots` -> Select your bot -> **API Token** -> **Revoke current token**.
3. Copy the newly issued `<NEW_BOT_TOKEN>`.

#### Step 3: Update `BOT_TOKEN` in Configuration
Update `BOT_TOKEN` with the new value in `.env` or the platform's secret manager:

```env
BOT_TOKEN=<NEW_BOT_TOKEN>
```

#### Step 4: Restart the Bot Process
Restart the process:

```bash
sudo systemctl restart mimir-telegram-bot
# or
docker compose restart mimir-telegram-bot
```

**Automatic Webhook Re-Registration:**
During boot in `src/index.ts`, the bot automatically calls Telegram's `setWebhook` API with the new credentials and generates a new secret token:
```ts
const webhookUrl = new URL("/telegram-webhook", config.telegramWebhookUrl).toString();
await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
```

#### Step 5: (Optional) Manual Webhook Inspection & Fallback
If incoming webhook updates are delayed or reporting delivery errors, inspect the webhook status directly using `curl`:

1. **Check Webhook Info:**
   ```bash
   curl -s "https://api.telegram.org/bot<NEW_BOT_TOKEN>/getWebhookInfo" | jq .
   ```
   Verify that `url` points to your configured webhook URL and `has_custom_certificate` / `pending_update_count` / `last_error_message` are normal.

2. **Manual Webhook Re-registration (if ever required):**
   ```bash
   curl -s -X POST "https://api.telegram.org/bot<NEW_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://bot.example.com/telegram-webhook"}'
   ```

3. **Clearing Stale Webhooks:**
   If switching back from webhook mode to long-polling mode, delete the existing webhook registration:
   ```bash
   curl -s "https://api.telegram.org/bot<NEW_BOT_TOKEN>/deleteWebhook" | jq .
   ```

---

## 5. Verification After Restart

Confirm that the new token is active and the bot is operating normally.

### 5.1 Verify via the `/health` Endpoint
Query the local HTTP health server (default port `8787` on `127.0.0.1`):

```bash
curl -s http://127.0.0.1:8787/health | jq .
```

Verify the following response fields:
* **HTTP Status:** `200 OK`
* **`ok`:** `true`
* **`status`:** `"ok"` (not `"degraded"` or `"stopped"`)
* **`poller.running`:** `true`
* **`poller.consecutiveFailures`:** `0`
* **`config` (Provenance):** Verify provenance entries report where configuration was loaded from:
  ```json
  "config": {
    "provenance": {
      "BOT_TOKEN": ".env",
      "TELEGRAM_CHAT_ID": ".env"
    }
  }
  ```
  *(Note: Health outputs report setting origins, never the raw token values).*

### 5.2 Verify Runtime Startup Logs
Examine the process boot logs:

* **Long-Polling Mode:**
  ```text
  [boot] Mimir Telegram notifier
  [boot] telegram ok, running as @your_bot_username
  ```
* **Webhook Mode:**
  ```text
  [boot] Mimir Telegram notifier
  [boot] telegram ok, listening for webhooks at https://bot.example.com/telegram-webhook
  ```
* **Redaction Confirmation:** Check that the boot provenance summary prints without secret exposure:
  ```text
  [boot] chat         configured (value redacted)
  [boot] config       ...
  ```
* **Absence of Authentication Errors:** Ensure there are no fatal long-polling errors such as:
  ```text
  [fatal] telegram long-polling failed — check BOT_TOKEN: [REDACTED]
  ```

### 5.3 Interactive Telegram Verification
In an authorized Telegram chat (or as `OPERATOR_TELEGRAM_USER_ID`), send:
* `/health` — Returns real-time health and uptime.
* `/status` — Returns poller status and cursor state.

If the bot replies promptly, end-to-end send and receive authentication is operational.

---

## 6. Secret Auditing & Cleanup

After rotating a token (especially after a suspected leak), audit the system to ensure the old token is removed from all files and logs.

### 6.1 Locations Likely to Contain the Old Token
Check the following locations where tokens commonly get stored or cached:
* **Working Tree & Configuration Files:** `.env`, `.env.local`, `.env.bak`, `.env.backup`, `docker-compose.yml`, or scratch scripts.
* **Process Manager Configurations:** `/etc/systemd/system/mimir-telegram-bot.service`, container environment overrides.
* **Shell History:** Inspect `~/.bash_history` or `~/.zsh_history` for interactive commands (e.g., `export BOT_TOKEN=...` or `curl .../bot<TOKEN>/...`).
* **Deployment & CI Logs:** Check recent CI runner output or deployment logs to confirm the old token was not printed in cleartext.

### 6.2 Auditing the Working Tree with `npm run scan:secrets`
The repository includes a zero-dependency secret scanner pinned by regression tests (`scripts/scan-secrets.mjs`):

```bash
npm run scan:secrets
```

**How the scanner works:**
* Inspects all tracked files and untracked (non-gitignored) text files.
* Checks against predefined signatures, including:
  * `telegram-bot-token`: BotFather format `\b\d{9,10}:[A-Za-z0-9_-]{35,}\b`
  * `generic-assignment`: Variable assignments matching `BOT_TOKEN = "..."` or similar
  * Other secret signatures (Stellar secret seeds, private key blocks, bearer tokens).
* **Clean Scan Output:**
  ```text
  secret scan ok — 128 file(s) scanned, 0 findings
  ```
  Returns exit code `0`.
* **Finding Detected Output:**
  If a token is found in an untracked file or tracked code, the scanner outputs line numbers and redacted previews:
  ```text
  secret scan failed: 1 finding(s) in 1 file(s) — scratch.txt (1)
    scratch.txt:3  [telegram-bot-token]  …token = "[REDACTED]"…
  ```
  Returns exit code `1`.

> **Note on `.env`:** Because `.env` is listed in `.gitignore`, `git ls-files` ignores it during ordinary repository scans to prevent local development flags from failing CI. Always manually verify that `.env` on your deployment host contains only the new token and that no leftover `.env.bak` or `.env.tmp` files remain.

### 6.3 Git History Remediation (If Committed)
If the old token was accidentally committed to Git:
1. **Revoke immediately:** Revoking via BotFather (Step 2 above) instantly invalidates the token with Telegram, neutralizing attacker access even if the token remains in Git history.
2. **History Rewrite:** Use tools such as `git-filter-repo` or BFG Repo-Cleaner to purge the sensitive commits from the repository history before force-pushing to protected branches.

---

## 7. Troubleshooting & Recovery

| Issue | Cause | Resolution |
| --- | --- | --- |
| `[fatal] telegram long-polling failed — check BOT_TOKEN: 401: Unauthorized` | New token was typed incorrectly, truncated, or contained extra whitespace. | Check `.env` for extra spaces or missing characters. Re-copy the token from BotFather. |
| `InstanceLockError: failed to acquire exclusive lock` | The previous bot process did not terminate or drain before the new instance started. | Allow the previous process to finish draining, or check running processes (`pgrep -f "dist/index.js"`) and stop the stale instance. |
| Webhook updates not arriving | Webhook was not re-registered with the new token or public DNS/firewall changed. | Query `https://api.telegram.org/bot<NEW_BOT_TOKEN>/getWebhookInfo` to verify the webhook URL and check for reported connection errors. |
| Bot not responding to `/status` | Authorized chat ID mismatch or allowlist restriction. | Verify `ALLOWED_CHAT_IDS` and `TELEGRAM_CHAT_ID` in `.env` match your Telegram user/group IDs. |
