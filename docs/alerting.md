# Prometheus Alerting Guide

This guide explains the example Prometheus alerting rules shipped in [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) for monitoring the Mimir Telegram bot in production.

---

## 1. Metrics Overview

The bot exposes Prometheus text-format (`0.0.4`) metrics from two built-in endpoints:

1. **Health & Readiness Server (`GET /metrics` on `HEALTH_PORT`, default `8787`)** — rendered by `buildMetricsReport` in [`src/health.ts`](../src/health.ts). Every metric is labeled with `network` (and per-target ledger metrics include `source` and `contract`).
2. **Optional Standalone Metrics Server (`GET /metrics` on `METRICS_PORT`)** — rendered by `createMetrics` in [`src/metrics.ts`](../src/metrics.ts) with the `mimir_bot_` prefix when `METRICS_PORT` is explicitly configured.

The alert rules in [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) target the default health server's `mimir_telegram_*` metrics so operators only need a single scrape job against `HEALTH_PORT`.

### Example Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: mimir_telegram_bot
    scrape_interval: 30s
    metrics_path: /metrics
    static_configs:
      - targets: ["127.0.0.1:8787"]
```

---

## 2. Validating the Rules with `promtool`

Before deploying changes to [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml), validate the syntax and PromQL expressions using `promtool` (ships with Prometheus):

```bash
promtool check rules deploy/prometheus/alerts.yml
```

Expected output:

```text
Checking deploy/prometheus/alerts.yml
  SUCCESS: 4 rules found
```

---

## 3. Alert Rules & Thresholds

| Alert Name | Metric(s) Referenced | Expression / Threshold | `for` Duration | Severity |
| :--- | :--- | :--- | :--- | :--- |
| `MimirTelegramBotProcessDown` | `mimir_telegram_poller_running` | `mimir_telegram_poller_running == 0` | `2m` | `critical` |
| `MimirTelegramBotRpcFailureStreak` | `mimir_telegram_consecutive_failures` | `mimir_telegram_consecutive_failures >= 5` | `2m` | `warning` |
| `MimirTelegramBotRepeatedSendFailures` | `mimir_telegram_notifications_failed_total` | `increase(mimir_telegram_notifications_failed_total[15m]) >= 3` | `0m` | `warning` |
| `MimirTelegramBotStaleCursor` | `mimir_telegram_latest_ledger`, `mimir_telegram_target_last_event_ledger` | `(mimir_telegram_latest_ledger - on(network) group_left(source, contract) mimir_telegram_target_last_event_ledger) > 100000` | `10m` | `warning` |

### 3.1 `MimirTelegramBotProcessDown` (Process Down / Poller Stopped)

* **Expression:** `mimir_telegram_poller_running == 0`
* **Duration (`for`):** `2m`
* **Why this threshold:** `mimir_telegram_poller_running` is a gauge set to `1` while the poll loop is actively running and `0` when the poller is stopped or paused via `/pause`. Waiting `2m` avoids paging on brief rolling restarts or redeployments while catching a stopped loop or forgotten operator pause.
* **Operator action:**
  1. Check `/status` in Telegram or `curl -s http://127.0.0.1:8787/health | jq .poller` to see if `paused: true` was set by an operator (`/resume` clears it).
  2. If the scrape target itself is unreachable (`up == 0`), inspect the container or systemd supervisor logs and verify the persistent `/app/data` volume mount.

### 3.2 `MimirTelegramBotRpcFailureStreak` (RPC Failure Streak)

* **Expression:** `mimir_telegram_consecutive_failures >= 5`
* **Duration (`for`):** `2m`
* **Why this threshold:** `mimir_telegram_consecutive_failures` is a gauge tracking consecutive failed poll cycles (resetting to `0` on the first successful scan). A threshold of `5` matches the poller's first structured circuit-breaker warning threshold (`5, 10, 25, 50, 100`) and exceeds the default readiness failure budget (`3` cycles at `POLL_INTERVAL_MS=30000`). Holding for `2m` filters out momentary network blips.
* **Operator action:**
  1. Inspect `GET /health` (`poller.lastError`) or run `npm run scan` to test `STELLAR_RPC_URL` reachability and check for HTTP 429 rate limits or 5xx responses.
  2. Do not manually edit or delete `data/cursor.json`—failed RPC cycles leave the persisted cursor untouched so the bot resumes cleanly once the RPC recovers. See [Incident Runbook — RPC failures](./incident-runbook.md#rpc-failures).

### 3.3 `MimirTelegramBotRepeatedSendFailures` (Repeated Send Failures)

* **Expression:** `increase(mimir_telegram_notifications_failed_total[15m]) >= 3`
* **Duration (`for`):** `0m`
* **Why this threshold:** Each notification already attempts up to 4 deliveries with exponential backoff and `Retry-After` handling inside `sendWithRetry` before incrementing `mimir_telegram_notifications_failed_total` (and parking the message in the dead-letter queue). Three or more exhausted send failures within 15 minutes indicates a persistent Telegram issue (revoked `BOT_TOKEN`, bot removed from chat, permissions revoked, or prolonged Telegram API outage) rather than a single transient rate limit.
* **Operator action:**
  1. Check `/audit` or `GET /health` (`poller.deadLetter` and `poller.lastError`).
  2. Verify `BOT_TOKEN` and confirm the bot still has permission to post in `TELEGRAM_CHAT_ID`.
  3. Once fixed, queued messages in `DEAD_LETTER_FILE` (`data/dead-letter.json`) will replay automatically on subsequent cycles. See [Incident Runbook — Telegram failures](./incident-runbook.md#telegram-failures).

### 3.4 `MimirTelegramBotStaleCursor` (Stale Cursor / Ledger Lag)

* **Expression:**
  ```promql
  (
    mimir_telegram_latest_ledger
    - on(network) group_left(source, contract) mimir_telegram_target_last_event_ledger
  ) > 100000
  ```
* **Duration (`for`):** `10m`
* **Why this threshold:** Soroban RPC retains a rolling window of approximately `120,960` ledgers (~7 days on Testnet at ~5s per ledger). When the gap between `mimir_telegram_latest_ledger` and a target's `mimir_telegram_target_last_event_ledger` exceeds `100,000` ledgers (~83% of the retention window) for `10m`, the target is approaching the RPC retention floor (`oldestLedger`). Note that on a completely quiet contract with zero on-chain events for days, `last_event_ledger` will naturally age even while the cursor itself advances; cross-check `GET /health` (`poller.targets[].cursorStale`, `cursorStalled`, and `poller.cursorRewinds`) to distinguish a quiet contract from a stalled or stale cursor. If `METRICS_PORT` is also scraped, you can pair this with `increase(mimir_bot_stale_cursor_events_total[15m]) > 0`.
* **Operator action:**
  1. Query `curl -s http://127.0.0.1:8787/health | jq .poller` and check `targets[].cursorStale`, `targets[].cursorStalled`, `cursorRewinds`, and `lastRestartGap`.
  2. If the poller was down and missed ledgers that are still within RPC retention, use `npm run replay -- --from <ledger>` to inspect or recover missed notifications. See [Replaying Missed Ledgers](./replaying-ledgers.md) and [Incident Runbook — Stale or corrupt cursor](./incident-runbook.md#stale-or-corrupt-cursor).
