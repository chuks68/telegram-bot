# ADR 0004: Telegram Long-Polling by Default with Optional Webhook Mode

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

In addition to pushing contract notifications via `sendMessage`, the bot receives incoming Telegram updates for user and operator commands (`/start`, `/help`, `/status`, `/health`, `/contracts`, `/preview`, `/pause`, `/resume`, `/audit`, `/export`) and inline keyboard callbacks.

Telegram bots can receive updates in two mutually exclusive modes:

1. **Long-polling (`getUpdates`):** The bot initiates outbound HTTPS requests to Telegram. It requires no public IP address, inbound firewall rules, DNS, or TLS termination, but Telegram allows only one active `getUpdates` consumer per bot token at a time.
2. **Webhook (`setWebhook`):** Telegram pushes updates via HTTPS `POST` requests to a publicly reachable URL controlled by the operator. This avoids outbound polling loops for commands, but requires public ingress, TLS termination, and protection against forged requests on the HTTP listener.

## Decision

Support both modes from the same entry point (`src/index.ts`), defaulting to **long-polling** and enabling **webhook mode** when `TELEGRAM_WEBHOOK_URL` is configured:

1. **Acquire instance lock before starting Telegram updates:** `poller.start()` acquires the exclusive instance lock (`acquireInstanceLock`) before Telegram update reception begins, preventing a duplicate local instance from racing the cursor file or fighting over `getUpdates`.
2. **Default to non-blocking long-polling:** When `TELEGRAM_WEBHOOK_URL` is unset, `src/index.ts` calls `bot.start()` without awaiting its completion (since `bot.start()` resolves only when the bot stops). Transient network errors are retried internally by grammy; an unrecoverable authentication failure logs a redacted fatal error, stops the poller, and exits non-zero so the supervisor can alert or restart.
3. **Optional webhook mounted on the health HTTP server with a per-process secret:** When `TELEGRAM_WEBHOOK_URL` is set (`config.telegramWebhookUrl`), `src/index.ts` generates a 32-byte random hex `webhookSecret` at boot, mounts grammy's `webhookCallback(bot, "http", { secretToken: webhookSecret })` on the existing health server (`startHealthServer`) at `POST /telegram-webhook`, and registers `new URL("/telegram-webhook", config.telegramWebhookUrl)` with Telegram via `bot.api.setWebhook(..., { secret_token: webhookSecret })`.

## Consequences

### Positive

- **Zero-ingress default deployment:** Out of the box, the bot runs behind NAT, in local development, or in a private container with outbound-only internet access and loopback-only health checks (`127.0.0.1:8787`).
- **Single HTTP listener in webhook mode:** Deployments that prefer webhooks do not need a second HTTP server or port; `/telegram-webhook` is served alongside `/health` and `/health/live`.
- **Forged-update protection:** Because `webhookSecret` is generated randomly per process boot and verified via Telegram's `X-Telegram-Bot-Api-Secret-Token` header, exposing the HTTP server for webhooks cannot be used by unauthenticated callers to inject fake Telegram updates.

### Negative / Trade-offs

- **Single active instance per bot token:** Long-polling cannot be horizontally scaled across multiple replicas, and even in webhook mode the cursor file and instance lock require a single active poller process per chat.
- **Webhook registration on boot:** Switching from webhook mode back to long-polling (or changing `TELEGRAM_WEBHOOK_URL`) requires Telegram's webhook registration to be updated or cleared (`bot.start()` in grammy deletes any active webhook automatically on startup).

## Code References

- [`src/index.ts`](../../src/index.ts) — `main()` wiring `webhookSecret`, `startHealthServer()`, `poller.start()`, `bot.api.setWebhook()`, and `bot.start()`.
- [`src/health.ts`](../../src/health.ts) — `startHealthServer()` routing `POST /telegram-webhook` to `webhookHandler`.
- [`src/config.ts`](../../src/config.ts) — `TELEGRAM_WEBHOOK_URL` (`config.telegramWebhookUrl`) parsing and validation.
- [`src/instanceLock.ts`](../../src/instanceLock.ts) — `acquireInstanceLock()` preventing concurrent instances from racing cursors or `getUpdates`.
