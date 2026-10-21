# HTTP Endpoints

The bot exposes two independent HTTP listeners, both bound to loopback by
default. This document covers every route on both servers, their response
shapes, status codes, and how to reach them safely.

---

## Bind addresses and security

Neither server is exposed to the public internet by default.

**Health server** (`HEALTH_HOST`, default `127.0.0.1`, port `HEALTH_PORT`,
default `8787`) serves readiness, liveness, and Prometheus metrics. Only the
process supervisor, a sidecar container, or a reverse proxy should reach it.

**Metrics server** (`METRICS_PORT`, no default — disabled unless set) is a
separate listener on the same loopback host. It is optional and exists to
give Prometheus scrapers a dedicated port without mixing operational traffic
with health checks.

Because both listeners bind `127.0.0.1` by default, any client on the same
host can read them. If you deploy on a platform that routes probes from a
different host (container network, Kubernetes pod network, Railway health
checker) you must change the bind address:

```dotenv
HEALTH_HOST=0.0.0.0   # reachable from any interface
HEALTH_PORT=8787
```

Never set `HEALTH_HOST=0.0.0.0` without a firewall rule or network policy
that restricts who can reach the port. The health response includes
configuration provenance (which env var supplied each setting) and poller
counters. It contains no secrets, but it does confirm what is running.

---

## Health server — `HEALTH_PORT` (default 8787)

### `GET /`

Discovery index. Returns a JSON object mapping each route name to its path.
Never returns a non-200.

**Response — 200**

```json
{
  "service": "mimir-telegram-bot",
  "health": "/health",
  "live": "/health/live",
  "metrics": "/metrics"
}
```

```bash
curl -s http://127.0.0.1:8787/
```

---

### `GET /health` (alias: `GET /healthz`)

Readiness probe. Returns the full `HealthReport` object. Use this for deploy
smoke-tests, Kubernetes readiness probes, and dashboards. The HTTP status code
is the machine-readable signal; the JSON body adds detail.

| Condition | `status` | `ok` | HTTP |
|---|---|---|---|
| Poller running, recent successful poll | `"ok"` | `true` | 200 |
| Poller running but paused by operator | `"ok"` | `true` | 200 |
| Poller draining (graceful shutdown) | `"ok"` | `true` | 200 |
| Too many consecutive failures, stale, stale/stalled cursor | `"degraded"` | `false` | 503 |
| Poller not running | `"stopped"` | `false` | 503 |

**Response body fields**

```jsonc
{
  "ok": true,                          // true only when status === "ok"
  "status": "ok",                      // "ok" | "degraded" | "stopped"
  "service": "mimir-telegram-bot",
  "version": "0.1.0",
  "network": "testnet",
  "uptimeMs": 3720000,
  "checkedAt": "2026-10-19T10:00:00.000Z",
  "poller": {
    "running": true,
    "paused": false,                   // true after /pause, clears on restart
    "stopping": false,                 // true during graceful shutdown drain
    "channelPreviewMode": false,
    "cycles": 744,
    "lastCorrelationId": "a1b2c3d4",   // opaque ID for the last cycle's logs
    "lastPollAt": "2026-10-19T09:59:55.000Z",
    "lastSuccessAt": "2026-10-19T09:59:55.000Z",
    "latestLedger": 5123456,
    "oldestLedger": 5063456,           // RPC retention floor
    "chainClockAt": "2026-10-19T09:59:50.000Z",
    "chainClockSkewMs": 5000,          // nowMs - chainClockAt; null until first obs.
    "notificationsSent": 12,
    "notificationsFailed": 0,
    "eventsSkipped": 2,
    "eventsDeduplicated": 0,
    "notificationsDropped": 0,
    "cursorRewinds": 0,                // auto floor-rewinds since process start
    "deadLetter": {
      "depth": 0,                      // messages currently parked
      "enqueued": 0,                   // lifetime total parked
      "replayed": 0,                   // lifetime total replayed successfully
      "dropped": 0                     // exhausted retries and discarded
    },
    "consecutiveFailures": 0,
    "suppressedLogs": 0,
    "lastError": null,                 // { at: ISO8601, message: string } or null
    "restartGaps": 0,
    "lastRestartGap": null,            // { at, source, cursorLedger, oldestLedger, missedLedgers } or null
    "pendingFlush": false,
    "lastFlushAt": "2026-10-19T09:59:55.000Z",
    "targets": [
      {
        "source": "market",
        "version": "v1",
        "contractId": "CABC...XYZ",
        "lastCycleMs": 320,            // duration of the last attempted cycle
        "maxCycleMs": 840,             // longest cycle since process start
        "lastEventLedger": 5121000,
        "cursorPreview": "0051210001234…", // first 24 chars; opaque, not a secret
        "gapLedgers": 0,
        "cursorResetAt": null,
        "cursorUnreadable": false,
        "rewindFromLedger": null,      // non-null during an active floor recovery
        "cursorStale": false,          // true = RPC rejected cursor; 503 until clear
        "cursorStalled": false,        // true = cursor unchanged while behind tip
        "cyclesWithoutAdvance": 0,
        "hasError": false
      }
    ],
    "persistentVolumeAvailable": true,
    "persistentVolumeError": null
  },
  "config": {
    // Key names and their source (env var name, default, etc.). No values.
    "BOT_TOKEN": { "source": "env" },
    "CHAT_ID":   { "source": "env" }
    // … one entry per recognised config key
  }
}
```

```bash
# Quick check — exit code 0 on 200, non-zero on 503
curl -sf http://127.0.0.1:8787/health | jq .ok

# Raw status only
curl -s http://127.0.0.1:8787/health | jq .status

# Dead-letter queue depth
curl -s http://127.0.0.1:8787/health | jq .poller.deadLetter.depth
```

---

### `GET /health/live` (alias: `GET /livez`)

Liveness probe. Always returns 200 as long as the HTTP server can accept
connections. Does **not** reflect poller health. Use this for container
restart policies — a 503 here means the Node process is deadlocked or
OOM-killed, not that the poller is behind.

**Response — always 200**

```jsonc
{
  "ok": true,
  "status": "live",
  "service": "mimir-telegram-bot",
  "version": "0.1.0",
  "checkedAt": "2026-10-19T10:00:00.000Z"
}
```

```bash
curl -sf http://127.0.0.1:8787/health/live
```

---

### `GET /metrics`

Prometheus text exposition (format version 0.0.4). Scraped by Prometheus or
any OpenMetrics-compatible agent. The response carries only operational
counters derived from in-process state — no env vars, tokens, or cursor
contents.

**Response — 200**, `Content-Type: text/plain; version=0.0.4; charset=utf-8`

```text
# HELP mimir_telegram_uptime_ms Uptime in milliseconds
# TYPE mimir_telegram_uptime_ms gauge
mimir_telegram_uptime_ms{network="testnet"} 3720000

# HELP mimir_telegram_poller_running Whether the poller is currently running (1) or stopped/paused (0)
# TYPE mimir_telegram_poller_running gauge
mimir_telegram_poller_running{network="testnet"} 1

# HELP mimir_telegram_poller_cycles_total Total number of completed poll cycles
# TYPE mimir_telegram_poller_cycles_total counter
mimir_telegram_poller_cycles_total{network="testnet"} 744

# HELP mimir_telegram_notifications_sent_total Total number of Telegram messages successfully sent
# TYPE mimir_telegram_notifications_sent_total counter
mimir_telegram_notifications_sent_total{network="testnet"} 12

# HELP mimir_telegram_notifications_failed_total Total number of Telegram messages that failed to send after retries
# TYPE mimir_telegram_notifications_failed_total counter
mimir_telegram_notifications_failed_total{network="testnet"} 0

# HELP mimir_telegram_events_skipped_total Total number of events skipped (unrecognized, unformatted, or rate-limited)
# TYPE mimir_telegram_events_skipped_total counter
mimir_telegram_events_skipped_total{network="testnet"} 2

# HELP mimir_telegram_consecutive_failures Current number of consecutive failed poll cycles
# TYPE mimir_telegram_consecutive_failures gauge
mimir_telegram_consecutive_failures{network="testnet"} 0

# HELP mimir_telegram_latest_ledger Highest ledger seen by the poller
# TYPE mimir_telegram_latest_ledger gauge
mimir_telegram_latest_ledger{network="testnet"} 5123456

# HELP mimir_telegram_target_last_event_ledger Highest ledger in which an event was processed for a target
# TYPE mimir_telegram_target_last_event_ledger gauge
mimir_telegram_target_last_event_ledger{network="testnet",source="market",contract="CABC…"} 5121000
mimir_telegram_target_last_event_ledger{network="testnet",source="squad",contract="CDEF…"} 5121500
```

The `mimir_telegram_latest_ledger` and `mimir_telegram_target_last_event_ledger`
lines are omitted when no ledger has been observed yet (cold start or no
events seen).

```bash
curl -s http://127.0.0.1:8787/metrics

# Prometheus scrape_configs entry
# - job_name: mimir-telegram
#   static_configs:
#     - targets: ['127.0.0.1:8787']
```

---

### `POST /telegram-webhook` (webhook mode only)

Receives Telegram update payloads when `TELEGRAM_WEBHOOK_URL` is set. The
route is not registered when running in long-polling mode (the default); it
returns 404 in that case.

Telegram includes a per-process secret in the
`X-Telegram-Bot-Api-Secret-Token` header. grammY validates it before
processing the update. A missing or wrong header returns 401.

| Outcome | HTTP |
|---|---|
| Update processed | 200 |
| Wrong or missing secret | 401 |
| Long-polling mode active (no webhook handler) | 404 |

The secret is regenerated on every process start and never written to disk or
logged. Do not configure a static secret at the proxy layer — forward the
header unchanged. See [webhook-mode.md](webhook-mode.md) for full setup
instructions.

```bash
# Confirm the route is active (expect 401, not 404)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:8787/telegram-webhook
```

---

### `GET <any other path>`

**Response — 404**

```json
{ "ok": false, "error": "not_found" }
```

---

## Metrics server — `METRICS_PORT` (disabled by default)

This server is separate from the health server. It starts only when
`METRICS_PORT` is set to a non-zero integer. It binds `127.0.0.1` by default;
pass `METRICS_HOST` (or the `host` argument in `metrics.startServer`) to
override. Use it when you want Prometheus to scrape a dedicated port without
touching the health listener.

### `GET /metrics`

Same Prometheus text format as `GET /metrics` on the health server, but
sourced from the in-process `MetricsRegistry` (finer-grained counters — see
below). Returns 200 always.

**Response — 200**, `Content-Type: text/plain; version=0.0.4; charset=utf-8`

The metrics registry tracks:

| Metric name | Type | Description |
|---|---|---|
| `mimir_bot_poll_cycles_total` | counter | Poll cycles started |
| `mimir_bot_rpc_requests_total` | counter | Successful Soroban RPC `getEvents` calls |
| `mimir_bot_rpc_errors_total` | counter | Failed Soroban RPC calls |
| `mimir_bot_events_decoded_total` | counter | Events returned by the RPC and passed to the decoder |
| `mimir_bot_events_skipped_total` | counter | Events not notified (unknown type, no formatter, or cycle cap) |
| `mimir_bot_notifications_sent_total` | counter | Telegram messages successfully sent |
| `mimir_bot_notifications_failed_total` | counter | Telegram sends that threw (cursor still advanced) |
| `mimir_bot_stale_cursor_events_total` | counter | Times a stale-cursor warning was emitted |
| `mimir_bot_consecutive_failures` | gauge | Current consecutive full-cycle RPC failures (resets on success) |

```bash
METRICS_PORT=9090  # in .env or environment

curl -s http://127.0.0.1:9090/metrics
```

```yaml
# prometheus.yml scrape_configs
- job_name: mimir-telegram-metrics
  static_configs:
    - targets: ['127.0.0.1:9090']
```

---

### `GET /health` (metrics server)

Minimal liveness probe on the metrics server. Returns plain text `OK` (not
JSON). Useful when a platform requires a health path on every port it exposes.

**Response — 200**, `Content-Type: text/plain`

```
OK
```

```bash
curl -s http://127.0.0.1:9090/health
```

---

### `GET <any other path>` / non-GET methods

**Response — 404** (`text/plain`, body `Not Found`) or **405** for non-GET
methods (`Allow: GET` header set).

---

## Summary table

| Server | Method | Path | Status codes | Purpose |
|---|---|---|---|---|
| Health | GET | `/` | 200 | Route discovery index |
| Health | GET | `/health` | 200, 503 | Full readiness + poller detail |
| Health | GET | `/healthz` | 200, 503 | Alias for `/health` |
| Health | GET | `/health/live` | 200 | Liveness only (no poller state) |
| Health | GET | `/livez` | 200 | Alias for `/health/live` |
| Health | GET | `/metrics` | 200 | Prometheus text (poller-level) |
| Health | POST | `/telegram-webhook` | 200, 401, 404 | Webhook updates (webhook mode only) |
| Health | GET | `<other>` | 404 | — |
| Metrics | GET | `/metrics` | 200 | Prometheus text (registry-level) |
| Metrics | GET | `/health` | 200 | Plain-text liveness |
| Metrics | GET | `<other>` | 404 | — |
| Metrics | non-GET | `<any>` | 405 | — |

---

## Configuration reference

| Variable | Default | Effect |
|---|---|---|
| `HEALTH_HOST` | `127.0.0.1` | Bind address for the health server |
| `HEALTH_PORT` | `8787` (or `PORT` if set by platform) | TCP port; `0` disables the listener |
| `HEALTH_STALE_MS` | `90000` | `/health` returns 503 if no successful poll within this window |
| `METRICS_PORT` | _(unset — disabled)_ | TCP port for the separate metrics server; omit to disable |

See [configuration-reference.md](configuration-reference.md) for all
variables and [incident-runbook.md](incident-runbook.md) for how to use
`/health` during an incident.
