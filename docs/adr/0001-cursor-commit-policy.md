# ADR 0001: Cursor Commit Policy and Lossy Notification Delivery

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The poller runs continuously as a long-lived background process, scanning Soroban RPC (`getEvents`) for `mimir-market` and `mimir-squad` contract events and delivering notifications to Telegram.

Soroban RPC pagination returns a single opaque resume `cursor` covering an entire page of events rather than individual per-event cursors. During a poll cycle, several classes of failures can occur:

1. **RPC scan failure:** `getHealth()` or `readContractEvents()` fails or times out before a page is returned.
2. **Partial or failed Telegram delivery:** Individual messages in a returned page may be skipped (unknown events, admin events, feature-flag filters, `MAX_NOTIFICATIONS_PER_CYCLE` rate cap, or graceful shutdown drain) or fail after exhausting `sendWithRetry` attempts (for example, due to a revoked bot token, deleted chat, or prolonged Telegram outage).
3. **Stale or corrupt cursor state:** A persisted cursor may fall behind the Soroban RPC's retained ledger window (`oldestLedger`) after an extended outage, or the on-disk cursor file may be corrupted.

If the poller held the cursor back whenever a Telegram send failed or a cycle hit the per-cycle notification cap, a broken chat configuration or transient outage followed by recovery would cause the bot to replay the entire page on every poll cycle, flooding the channel or wedging the notifier indefinitely.

## Decision

The Stellar blockchain is treated as the authoritative record, and Telegram notifications are lossy by design:

1. **Preserve cursor on RPC scan failure:** If a contract's RPC scan fails during a cycle, only that contract's scan fails for that cycle. Its cursor is left untouched so the next cycle resumes from the exact same position.
2. **Commit cursor after page processing, even on partial delivery:** Once a scan page is returned and processed, the poller advances `current.cursor` to `scan.cursor` and persists it to disk (via atomic write-then-rename `.tmp` to `cursor.json`, plus a `.bak` copy), even if some notifications were skipped, capped by `MAX_NOTIFICATIONS_PER_CYCLE`, dropped during a graceful shutdown drain, or failed after retries. When the optional dead-letter queue (`DEAD_LETTER_FILE`) is configured, exhausted sends are parked there for bounded replay without holding back the scan cursor.
3. **Bounded stale-cursor floor rewind:** When a cursor's ledger is provably below the RPC's retained `oldestLedger` (verified against a fresh `getHealth()` window), the poller drops the unreachable cursor and rewinds `rewindFromLedger` to `oldestLedger` (up to `MAX_FLOOR_REWINDS` consecutive attempts). Opaque cursors whose ledger cannot be parsed or cursors ahead of tip are never guessed at and are left untouched.
4. **Quarantine corrupt cursor files:** If the cursor file on disk cannot be parsed or fails schema validation, it is renamed to `*.corrupt.<timestamp>` and the poller performs a cold start (`START_LOOKBACK_LEDGERS` behind chain tip).

## Consequences

### Positive

- **No infinite replay loops:** A bad Telegram chat ID, revoked token, or rate-capped burst never traps the poller into re-sending the same page every cycle.
- **Per-contract fault isolation:** An RPC error on one contract (`market` or `squad`) does not block or roll back progress on the other.
- **Crash-safe persistence:** Write-then-rename cursor persistence and bounded shutdown draining ensure restarts resume cleanly from the last processed page.
- **Self-healing after retention gaps:** Proven stale cursors automatically resume from the oldest retained ledger without operator intervention, up to the safety budget.

### Negative / Trade-offs

- **At-most-once cursor progression:** Events whose Telegram delivery fails all retry attempts (when dead-letter persistence is disabled or exhausted) or exceeds `MAX_NOTIFICATIONS_PER_CYCLE` are not re-read from the chain automatically; operators must use the ledger replay CLI if historical backfill is desired.
- **Gap events below RPC retention are unrecoverable from RPC:** When a cursor falls behind `oldestLedger`, events in the missed ledger gap cannot be fetched from the rolling RPC window and are reported via `restartGaps` / `cursorRewinds` metrics and status output.

## Code References

- [`src/poller.ts`](../../src/poller.ts) — Top-level failure policy comment, `cycle()` cursor advancement after `notify()`, `saveCursors()` atomic write-then-rename persistence, `loadCursors()` corruption quarantine, and `rewindFromRetainedFloor()`.
- [`src/stellar/events.ts`](../../src/stellar/events.ts) — `readContractEvents()`, `eventCursorLedger()`, and `resumeCursorProblem()`.
- [`src/deadLetter.ts`](../../src/deadLetter.ts) — Optional dead-letter queue used to park failed sends while still advancing the scan cursor.
