# Structured Logging & JSON Mode Reference

This document describes the structured logging system implemented in `src/logger.ts`, including the JSON line schema, log levels, scopes (components), field boundaries, sampling controls, redaction guarantees, and examples for log aggregator ingestion and filtering.

---

## Overview & Configuration

The bot supports two log formats configured via environment variables:

| Variable | Values / Format | Default | Description |
|---|---|---|---|
| `LOG_FORMAT` | `text`, `json` | `text` | When set to `json`, emits one self-contained, un-indented JSON object per log record on stdout/stderr. Case-insensitive; falls back to `text` if invalid. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `fatal` | `info` | Minimum log severity to emit. Records with lower severity are suppressed. Case-insensitive; falls back to `info` if invalid. |

In addition, standard output streams follow severity conventions:
- `error` and `fatal` are written to `stderr` (`console.error`).
- `warn` is written to `console.warn`.
- `debug` and `info` are written to `stdout` (`console.log`).

---

## JSON Line Shape & Schema

When `LOG_FORMAT=json`, each log entry is serialized as a single-line JSON string (`{"ts":...,"level":...,"component":...,"msg":...,...}`).

### Canonical Envelope Fields

Every JSON log record contains these canonical top-level fields (guaranteed not to be overwritten or shadowed by caller-supplied fields):

| Field | Type | Description |
|---|---|---|
| `ts` | `string` | ISO 8601 UTC timestamp of emission (e.g. `"2026-10-18T19:45:00.000Z"`). |
| `level` | `string` | Log severity level: `"debug"`, `"info"`, `"warn"`, `"error"`, or `"fatal"`. |
| `component` | `string` | Log scope / subsystem emitting the record (e.g. `"boot"`, `"poller"`, `"shutdown"`, `"process"`). |
| `msg` | `string` | Redacted log message string. |

### Contextual Fields

Callers pass optional metadata objects that are merged directly at top-level into the record.

Common convention across components:
- `action`: A machine-readable snake_case identifier indicating the specific event or failure (e.g. `"start"`, `"paused"`, `"resumed"`, `"rpc_health"`, `"event_skipped"`, `"format_failed"`, `"notification_cap_reached"`, `"cursor_persist_failed"`, `"uncaught_exception"`, `"unhandled_rejection"`).

---

## Scopes (Components) & Known Fields

### 1. `boot`
Emitted during initialization, configuration loading, RPC health checks, and Telegram client startup.

| Field | Type | Description |
|---|---|---|
| `action` | `string` | `"rpc_health"`, `"telegram_start_failed"`, `"config_error"`, `"startup_failed"`. |
| `profile` | `string` | Active profile name when `MIMIR_PROFILE` is set. |
| `operatorConfigured` | `boolean` | Whether an operator Telegram user ID is configured. |
| `channelPreviewMode` | `boolean` | Whether channel preview mode is enabled. |
| `provenance` | `object` | Safe breakdown of config settings and their sources (environment, defaults, files), value-free. |
| `warning` | `string` | Warning messages generated during configuration provenance parsing. |
| `attempts` | `number` | Number of RPC connection attempts performed during startup health check. |
| `status` | `string` | RPC startup health status (e.g. `"ok"`). |
| `oldestLedger` | `number` | Earliest available ledger retained by Soroban RPC. |
| `latestLedger` | `number` | Most recent ledger known to Soroban RPC. |
| `telegramOk` | `boolean` | `true` when Telegram connection / webhook verification succeeds. |
| `mode` | `string` | Telegram mode (`"webhook"`). |
| `username` | `string` | Bot username when running in polling mode. |
| `problems` | `string[]` | List of validation problems on `ConfigError`. |

### 2. `poller`
Emitted by the poller loop during event ingestion, cursor management, cycle execution, and rate limiting.

| Field | Type | Description |
|---|---|---|
| `action` | `string` | `"start"`, `"paused"`, `"resumed"`, `"resume"`, `"cursor_quarantined"`, `"cursor_quarantine_failed"`, `"cursor_persist_failed"`, `"event_skipped"`, `"format_failed"`, `"notification_cap_reached"`, `"persistent_volume_unwritable"`. |
| `marketContractId` | `string` | Mimir market contract address watched. |
| `squadContractId` | `string` | Mimir squad contract address watched. |
| `pollIntervalMs` | `number` | Polling interval in milliseconds. |
| `cursorFile` | `string` | Path to persistent cursor file. |
| `quarantined` | `string` | Destination path of quarantined corrupt cursor file. |
| `cursorDir` | `string` | Directory of cursor storage volume. |
| `targets` | `array` | Array of watch targets, each containing `{ source, cursor, lastEventLedger, rewindFromLedger }`. |
| `source` | `string` | Event origin contract (`"market"` or `"squad"`). |
| `eventName` | `string` | Bounded contract event topic/name (max 80 chars). |
| `eventId` | `string` | Unique event ID assigned by Soroban RPC. |
| `ledger` | `number` | Ledger sequence number of the event. |
| `reason` | `string` | Reason for skipping, quarantining, or failing. |
| `error` | `string` | Sanitized error message text. |
| `maxNotificationsPerCycle` | `number` | The configured per-cycle notification limit. |
| `droppedEvent` | `string` | Name of event dropped when cycle cap is exceeded. |

### 3. `shutdown`
Emitted during process signal trapping and graceful teardown drain.

| Field | Type | Description |
|---|---|---|
| `action` | `string` | `"teardown_timeout"`, `"drain_failed"`, `"health_close_failed"`, `"telegram_stop_failed"`, `"metrics_close_failed"`. |
| `signal` | `string` | Operating system signal caught (e.g. `"SIGINT"`, `"SIGTERM"`). |
| `forced` | `boolean` | `true` if a second signal forced an immediate non-graceful exit. |
| `teardownBudgetMs` | `number` | Maximum allowed timeout before forcing process exit. |
| `drained` | `boolean` | Whether the poller successfully finished in-flight work before exit. |
| `cursorFlushed` | `boolean` | Whether cursor state was successfully flushed to disk. |
| `waitedMs` | `number` | Milliseconds spent waiting for poller drain. |

### 4. `process`
Emitted by top-level Node.js error listeners.

| Field | Type | Description |
|---|---|---|
| `action` | `string` | `"unhandled_rejection"`, `"uncaught_exception"`. |

---

## Safety Bounds & Redaction

### Field Bounds
To protect log aggregators and prevent denial-of-service via massive RPC payloads:
- **String length truncation**: Any string field value longer than `MAX_LOG_FIELD_CHARS` (`1,000` characters) is truncated to 999 characters and suffixed with an ellipsis (`…`).
- **Object depth limit**: Deeply nested JSON structures are traversed up to `MAX_FIELD_DEPTH` (`4` levels). Anything deeper is replaced with `"[depth-limit]"`, protecting against circular references.
- **BigInt serialization**: `BigInt` values are converted to standard numeric strings (`value.toString()`).
- **Undefined & Functions**: Object keys whose values are `undefined` or functions are stripped before JSON serialization.
- **Fail-safe fallback**: If serializing `fields` throws unexpectedly, the logger emits the bare sanitized `msg` string so the process never crashes on logging.

### Redaction Rules
Every log record is redacted before it leaves the process:
1. **Registered Secrets**: Explicit secrets such as `config.botToken` and `config.chatId` are replaced with `[REDACTED]`.
2. **Telegram Token Pattern**: Any substring matching Telegram bot token shape (`\b\d{5,}:[A-Za-z0-9_-]{20,}/g`) is automatically replaced with `[REDACTED]`, even if not explicitly registered in secrets configuration.
3. **URL Redaction**: Internal helpers (`redactUrl`) mask HTTP basic auth or query credentials in URLs before logging.
4. **All Fields Protected**: Redaction applies recursively to both the log `msg` and all string values in custom `fields`.

---

## Error Sampling (`LOG_SAMPLE_WINDOW_MS` & `LOG_SAMPLE_MAX_PER_WINDOW`)

Repetitive RPC errors or network disconnects can flood aggregators. The poller passes errors through a bounded error sampler:

- **`LOG_SAMPLE_MAX_PER_WINDOW`** (default: `3`): Maximum number of identical error lines printed per sampling key within a time window.
- **`LOG_SAMPLE_WINDOW_MS`** (default: `300000`, 5 minutes; minimum: `1000`): Duration of the rolling window in milliseconds.

### Behavior:
1. The first `LOG_SAMPLE_MAX_PER_WINDOW` errors for a key inside the window are printed in full.
2. Subsequent repeats for that key within the window are suppressed and counted.
3. When the window expires, the first new occurrence prints with a notice indicating how many repeats were held back (e.g. `[+N identical lines suppressed in the last 300s]`).
4. In JSON mode, sampled errors still emit structured logs with canonical `level: "error"` and scope `component: "poller"`.

---

## Aggregator Ingestion & `jq` Examples

Because each JSON line is valid JSON, standard tools like `jq`, Vector, FluentBit, Datadog Agent, or Promtail/Loki can ingest and index fields directly.

### Filter All Errors and Fatal Messages
```bash
tail -f mimir.log | jq -c 'select(.level == "error" or .level == "fatal")'
```

### Filter Poller Errors with Message, Action, and Ledger
```bash
cat mimir.log | jq 'select(.component == "poller" and .level == "error") | {ts, action, ledger, error, msg}'
```

### Inspect Startup / Boot Configuration and Warnings
```bash
cat mimir.log | jq 'select(.component == "boot") | {ts, level, action, warning, msg}'
```

### Track Skipped or Dropped Events
```bash
cat mimir.log | jq 'select(.action == "event_skipped" or .action == "notification_cap_reached") | {ts, eventName, ledger, reason}'
```
