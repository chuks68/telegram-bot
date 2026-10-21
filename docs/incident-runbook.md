# Incident Runbook

Operational guidance for recovering the Mimir Telegram notifier from missed notifications, without treating Telegram as the source of truth.

## Operating principles

* Stellar chain state is the source of truth.
* The notifier is read-only and never holds signing keys or private keys.
* A notification failure must not alter on-chain state.
* Cursors must only move according to the poller's existing persistence rules.
* A shutdown flush may only persist cursors the poller already advanced; it never invents a resume position.
* Logs and status output must not expose bot tokens, private keys, payment proofs, or unbounded remote payloads.
  Scrubbing is centralized in `src/redact.ts` (regression suite: `tests/redaction.test.mjs`).

Notification text from contract String fields is bounded to 200 Unicode code
points before MarkdownV2 escaping. An oversized or malformed transaction hash
does not receive an explorer link. The original event is still decoded and the
cursor follows the normal poller rules; truncation affects only the Telegram
presentation, not chain data or persisted cursor state.

Notification text from contract String fields is bounded to 200 Unicode code
points before Markdownv2 escaping. An oversized or malformed transaction hash
does not receive an explorer link. The original event is still decoded and the
cursor follows the normal poller rules; truncation affects only the Telegram
presentation, not chain data or persisted cursor state.

## Quick health check

Run:

```bash
/health
```

Or for full poller state details:

```bash
/status
@``

Check:

* overall readiness and status (`ok`, `degraded`, `stopped`)
* current chain tip
* RPC retained-history floor
* chain clock skew (newest observed chain close time against this host's clock)
* watched contract IDs
* configuration provenance (`/health` -> `.config`, or the boot `[boot] config` line): which source supplied each setting, with no values
* last event ledger per contract
* persisted cursor
* poll/send counters, including automatic floor rewinds (`cursorRewinds`)
* any target resuming from a floor rewind (`rewindFromLedger`)
* last error and consecutive failure count

The correlation ID identifies the most recently started poll cycle. Use it to
group the bounded scan, malformed-event, rate-limit, send, and cycle-error log
lines for that cycle. A new process creates new IDs; they are intentionally not
stored in the version-1 cursor file or sent to Telegram.

For a read-only chain diagnostic without a Telegram token:

```bash
npm run scan
```

Use `--from`, `--pages`, or `--show` when a narrower or deeper scan is needed.

## Chain clock skew

`/status` and `GET /health` show how far this host's clock is from the newest
chain close time the poller has actually observed. `/health` exposes the same
numbers as `poller.chainClockAt` and `poller.chainClockSkewMs`.

* `in sync` — within one second of the observed chain time.
* `local clock … ahead of chain` — the usual reading: the observed chain time is
  older than this host by roughly the poll interval plus ledger close latency.
* `chain clock … ahead of local` — the observed chain time is in the future
  relative to this host. Check the host clock (NTP) before anything else.
* `unknown` — nothing observed yet: a cold start, or every scan so far returned
  no events for the watched contracts.

The clock only advances from a `ledgerClosedAt` the RPC actually returned, so it
freezes during R-PC failures, an open circuit breaker, an operator pause, or a
stretch with no events, and the skew then grows on its own. It is saved with the
cursors, so a restart resumes it instead of reporting `unknown`.

Reading it: growing skew while the cursor still advances, `consecutiveFailures`
stays at `0`, and the last event ledger is unchanged means the watched contracts
are quiet, not broken. Growing skew alongside `consecutiveFailures` points at the
RPC. `chain clock … ahead of local` points at this host's clock.

## Operator pause and resume

`/pause` and `/resume` require the numeric user id configured in
`OPERATOR_TELEGRAM_USER_ID`. A notification chat id is not authorization because
all members of a group can send commands there. Unauthorized attempts receive no
reply and do not change polling.

`/pause` cancels the next scheduled cycle. A cycle already reading events or
retrying Telegram may finish under its existing bounded limits and normal cursor
rules. `/resume` is idempotent and schedules the next cycle immediately; it does
not rewind, reset, or replay cursors and cannot recover messages already dropped
after Telegram failures.

Pause state is process-local. A restart always begins polling while loading the
existing version-1 cursor file, preventing a stale pause from surviving a deploy.
An operator pause is reported as healthy by `/health` with `poller.paused=true`.

## RPC failures

### Symptoms

* `/status` reports a recent RPC error.
* `/export` shows the per-target `[poller] … scan failed` lines leading up to it.
* One contract stops advancing while the other continues.
* Notifications from one contract are missing.

### Recovery

1. Confirm the RPC endpoint is reachable.
2. Run `npm run scan` to verify that the chain reader can access retained events.
3. Check the retained-history floor reported by the RPC.
4. Restart the process only if the underlying RPC problem has been resolved.

The affected contract's cursor is left unchanged after a failed scan, so the next polling cycle can retry from the same position. If the operator intentionally used `/pause`, use `/resume` only after the RPC is healthy; otherwise normal polling already retries on schedule.

Do not manually advance the cursor to skip an RPC failure.

## Telegram failures

For a quick mapping of raw Telegram error messages to fixes, see the
[Telegram Troubleshooting FAQ](telegram-troubleshooting.md).

### Symptoms

* Event scanning continues but sends fail.
* `/status` shows send errors or an increasing scan/send difference.
* The bot was removed from the chat or its token was revoked.
* `/export` shows the bounded send-retry warnings and the final
  `send failed … after retries` line, with the token itself always masked.

### Recovery

1. Confirm the bot token and chat configuration are valid.
2. Confirm the bot is still present in the target chat and has permission to post.
3. Use `/status` to confirm the process is still running and not intentionally paused.
4. Restart only when configuration has been corrected. If polling was deliberately paused, use `/resume` after the token/chat is healthy.

Telegram delivery is intentionally lossy. The poller commits the opaque cursor
after processing the returned page, even when sends are partial. A failed send
does not hold the cursor back — holding it would turn a revoked token into an
infinite replay, and replaying every missed notification could create an
unbounded backlog or flood a recovered chat. Instead the formatted message is
parked on the local dead-letter queue (`DEAD_LETTER_FILE`, default
`data/dead-letter.json`) and replayed on later cycles once Telegram accepts
sends again. See [Dead-Letter Queue documentation](dead-letter-queue.md) for details
on file format, entry fields, inspection with `jq`, retry limits, and queue management.
The log reports the sent/failed/skipped counts for that commit.

Each individual Telegram send is bounded by `TELEGRAM_SEND_TIMEOUT_MS` (default
`10000`). A send that exceeds this deadline is aborted and counted as a failure
for that event; the poller continues with the remaining events in the page and
commits the cursor under the normal rules. The timeout applies per send, not to
the whole cycle, so a single slow request cannot stall the poller indefinitely.

The Stellar chain remains the authoritative record.

## Stale or corrupt cursor

### Symptoms

* The cursor cannot be parsed.
* The stored cursor is incompatible with the current cursor format.
* The process reports a cursor-loading problem.
* `/status` reports `Cursors rewound to the retained floor: N`, or `status.json`
  / `GET /health` show a non-null `rewindFromLedger`, after a long outage.
* `GET /health` returns `503` and a target has `cursorStale: true`, even if the
  other watched contract is scanning successfully.
* `/status` shows send errors clustered around a single slow event, with the
  remaining events in the same page still delivered.

### Recovery

A corrupt cursor is quarantined beside the live path and treated as a cold start;
preserve the quarantined copy for investigation.

A syntactically valid cursor that Soroban rejects as stale is first checked
against a fresh `getHealth()`:
Timing out an individual send does not change cursor behavior: the cursor still
advances only after the returned page is processed, and a timed-out send is
treated exactly like any other failed send.

* If the cursor's ledger is **strictly below** `oldestLedger`, the position it
  points at is already unrecoverable, so the poller drops it and rescans from
  `oldestLedger`. This is bounded to `MAX_FLOOR_REWINDS` (3) consecutive
  automatic rewinds per contract. The count is visible in `/status` and
  `GET /health` as `cursorRewinds`, and an active recovery is the target's
  `rewindFromLedger` (also in `status.json` and `GET /health`).
* If the cursor cannot be placed (an opaque token), sits **inside** the window,
  or the window cannot be read, it is **kept unchanged** and the bounded RPC
  error is surfaced. `/resume` never changes a cursor.

A floor rewind loses nothing that is still readable — everything below the floor
has already left the RPC. It can, however, skip events that expired while the bot
was down, which the chain still records.

A cursor the token itself places **aead of the chain tip** is refused locally
with a bounded `ahead of the chain tip` error instead of being sent, and the
stored cursor is kept unchanged. That can be a transient RPC-lag condition and
clears as the tip advances; if it persists it means the cursor came from a
different chain (for example a network reset), so treat it as incompatible:
preserve the file and perform a deliberate cold start.

If the automatic rewind budget is spent (the process logs that operator action is
required) or the cursor cannot be placed, treat it as permanently stale: stop
the notifier, preserve the cursor file for investigation, and deliberately
cold-start with the configured `START_LOOKBACK_LEDGERS` after checking the
retained-history floor. A cold start may produce duplicate notifications, but it
does not replay all retained history.

Before changing `CURSOR_FILE` or deleting persisted state, preserve the existing file for investigation if possible. For an exhaustive reference of all on-disk files, writers, and recovery behaviors, see [On-Disk State Files](state-files.md).

If the stored cursor is confirmed incompatible or permanently outside RPC retention, stop the notifier, preserve the cursor file for investigation, and deliberately perform a cold start with the configured `START_LOOKBACK_LEDGERS` after checking the retained-history floor. This may produce duplicate notifications, but it does not skip or replay all retained history.

On a cold start, the poller begins from its configured lookback rather than replaying the entire retained RPC history.

Never replace a cursor with an arbitrary ledger or cursor value unless the repository's cursor format and retained-history requirements have been verified. `/pause` and `/resume` are safe alternatives because they leave the version-1 cursor file untouched.

### Back up or restore a cursor

Use the offline cursor CLI to preserve a valid reader position before a deploy
or deliberate recovery. A backup can run while polling: cursor writes are
atomic, so it captures either the prior or the newly committed complete file.
Keep the backup on persistent storage and preferably outside the directory
being replaced.

```bash
npm run cursor -- backup --out data/cursor-backup.json
```

Restore only after stopping the notifier. See [Cursor CLI reference](../README.md#cursor-backup-and-restore)
for the full subcommand and flag reference, including how to inspect a cursor
file and what `--force` overrides.
