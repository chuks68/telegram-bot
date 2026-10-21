# Poll Cycle Execution and Failure Policy

This document details the step-by-step execution flow of a single poll cycle within the Mimir Telegram notifier, focusing on the order of operations inside [`src/poller.ts`](../src/poller.ts) and its interactions with Soroban RPC and Telegram. It also explains failure modes (RPC failure, Telegram delivery failure, malformed XDR, and mid-cycle shutdown) and how they adhere to the cursor commit policy.

---

## Overview

The poller loop periodically executes `cycle()` to:
1. Replay any pending dead-letter queue items from earlier failed deliveries.
2. Query the chain tip via [`LedgerCache`](../src/stellar/ledger-cache.ts) and scan each watched contract sequentially using [`readContractEvents`](../src/stellar/events.ts) and [`paginatedGetEvents`](../src/stellar/events.ts).
3. Deduplicate events using [`eventKey`](../src/dedup.ts) and decode them via [`decodeEvent`](../src/stellar/decode.ts).
4. Deliver notifications via [`createNotifier`](../src/bot.ts) (wrapped in `sendWithRetry`).
5. Enqueue delivery failures into the dead-letter queue (if enabled via [`createDeadLetterQueue`](../src/deadLetter.ts)).
6. Commit the cursor and persist state via `saveCursors("cycle")` and `saveCounters("cycle")`.

---

## Sequence Diagram

The following Mermaid sequence diagram illustrates the lifecycle of a poll cycle across the major components:

```mermaid
sequenceDiagram
    autonumber
    participant Poller as Poller (src/poller.ts)
    participant DLQ as DeadLetterQueue (src/deadLetter.ts)
    participant LCache as LedgerCache (src/stellar/ledger-cache.ts)
    participant Scanner as Scanner (src/stellar/events.ts)
    participant RPC as Soroban RPC (rpc.Server)
    participant Decoder as EventDecoder (src/stellar/decode.ts)
    participant Notifier as Notifier (createNotifier / bot.ts)
    participant Telegram as Telegram Bot API
    participant Disk as Disk Storage (cursor & counters)

    Poller->>DLQ: flushDeadLetter()
    opt Has pending entries
        DLQ->>Notifier: Retry sending parked messages
        Notifier->>Telegram: bot.api.sendMessage()
    end

    Poller->>LCache: reset()
    loop For each watched contract target (market, squad)
        Poller->>LCache: get(server)
        opt Tip not yet cached for this cycle
            LCache->>RPC: getHealth()
            RPC-->>LCache: HealthResponse (latestLedger, oldestLedger)
        end
        LCache-->>Poller: ledgerTip

        Poller->>Scanner: readContractEvents(server, target, { ledgerTip, cursor, seenEventIds })
        Scanner->>Scanner: paginatedGetEvents(server, filters, opts)

        loop Cursor pagination (up to EVENT_MAX_PAGES)
            Scanner->>RPC: getEvents({ filters, cursor / startLedger, limit })
            RPC-->>Scanner: GetEventsResponse (events, latestLedger, cursor)
            Scanner->>Scanner: dedup.add(eventKey(event)) (drop in-scan duplicates)
        end

        loop For each raw event
            Scanner->>Decoder: decodeEvent(target.source, rawEvent, version)
            Note over Decoder: Malformed XDR decoded to 'unknown' payload
            Decoder-->>Scanner: DecodedEvent
        end

        Scanner-->>Poller: ContractScan (events, cursor, latestLedger, oldestLedger, seenEventIds)

        Poller->>Poller: Update dedupWindow with seenEventIds

        opt Has events to notify
            Poller->>Poller: notify(events, correlationId)
            loop For each DecodedEvent
                alt Event is admin or unknown or feature-flag disabled
                    Poller->>Poller: Skip notification (increment eventsSkipped)
                else Event is notifiable
                    Poller->>Notifier: send(text, source, extra)
                    loop sendWithRetry (up to 3 attempts with backoff)
                        Notifier->>Telegram: sendMessage(chatId, text, options)
                        alt Send succeeds
                            Telegram-->>Notifier: 200 OK
                        else Send fails
                            Telegram-->>Notifier: Error (network or rate limit)
                        end
                    end
                    alt All retries fail
                        Poller->>DLQ: enqueue({ source, ledger, eventName, text, error })
                        Note over Poller: Counted as failed; cycle continues
                    end
                end
            end
        end

        Poller->>Poller: Update in-memory target cursor (current.cursor = scan.cursor)
    end

    Poller->>Disk: saveCounters("cycle")
    Poller->>Disk: saveCursors("cycle")
```

---

## Detailed Step-by-Step Order of Operations

Within [`src/poller.ts`](../src/poller.ts), each execution of `cycle()` executes the following sequence:

1. **Cycle Tracking and Initialization**
   - Verifies that no previous cycle is `inFlight`.
   - Generates a cycle correlation ID (`randomUUID()`).
   - Checks the RPC circuit breaker (`status.circuitBreaker.open`). If open and the cooldown hasn't expired, the cycle terminates early.
   - Resets the per-cycle ledger cache with `ledgerCache.reset()`.

2. **Dead-Letter Queue Drain**
   - Calls `flushDeadLetter()`. If the dead-letter queue is enabled and has entries, queued notifications from previous failed deliveries are replayed first before processing new events.

3. **Per-Target Contract Scanning**
   - For each target contract (such as `mimir-market` and `mimir-squad`):
     1. **Backoff Check**: Skips the target if it is in an RPC backoff window (`currentTime < current.nextEligibleAt`).
     2. **Window Enforcement**: Invokes `enforceCursorWindow(target, current)` to verify the cursor is within the RPC's retained ledger range.
     3. **Tip Retrieval via `LedgerCache`**: Calls `ledgerCache.get(server)` (with a scan timeout). The first target in the cycle fetches the latest health info via RPC `getHealth()`; subsequent targets reuse the cached tip.
     4. **Contract Event Scanning**: Calls `readContractEvents(server, target, ...)`, which delegates to `paginatedGetEvents()`.
        - Queries `server.getEvents()` using either `cursor` or `startLedger`.
        - Walks up to `EVENT_MAX_PAGES` (20 pages).
        - Each raw event is checked against the dedup window using `eventKey(event)` from [`src/dedup.ts`](../src/dedup.ts). Duplicates are dropped and counted.
     5. **Event Decoding via `decodeEvent`**:
        - Each raw event is converted into a `DecodedEvent` by `decodeEvent()` in [`src/stellar/decode.ts`](../src/stellar/decode.ts).
        - Decoded events are sorted into deterministic chain order (ledger $\rightarrow$ transaction index $\rightarrow$ operation index $\rightarrow$ paging token).

4. **Event Notification and Dispatch**
   - The scanner returns `ContractScan` containing decoded events and `seenEventIds`.
   - `seenEventIds` are recorded in the poller's `dedupWindow` before delivery attempts.
   - `notify(scan.events, correlationId)` is invoked:
     - Admin events (`isAdminPayload`) and unrecognized events (`event.payload.name === "unknown"`) are skipped and logged.
     - Feature flags (`isNotificationAllowed`) are checked.
     - If shutdown is in progress (`status.stopping`), remaining notifications are dropped.
     - The message is formatted with MarkdownV2 (and fallback plain text).
     - Delivery is dispatched using `sendWithRetry` to the configured `send` function (created via `createNotifier` in [`src/bot.ts`](../src/bot.ts)).
     - If all retries fail, the failure counter is incremented, and the message is enqueued into the dead-letter queue via `deadLetter.enqueue()`.

5. **In-Memory Cursor Advance**
   - If `scan.cursor` has advanced, the in-memory cursor is updated (`current.cursor = scan.cursor`).
   - The cursor advances even if individual notifications failed or were skipped (adhering to the lossy cursor commit policy).

6. **State Persistence**
   - In the `finally` block of `cycle()`:
     - `saveCounters("cycle")` writes counters to disk.
     - `saveCursors("cycle")` atomically writes the updated cursors and dedup window to disk via a temporary file and rename.
     - `persistStatus()` writes `status.json`.

---

## Failure Modes and Cursor Commit Policy

The notifier follows ADR 0001: **lossy notification delivery by design**. The blockchain is the single source of truth, and cursors must not get stuck in infinite replay loops.

### 1. RPC Failure
- **What happens**: If `getHealth()` or `getEvents()` throws an RPC network or HTTP error, the exception is caught in the target scan loop.
- **Circuit Breaker & Backoff**: Exponential backoff is applied to the failed target (`current.nextEligibleAt`). Target consecutive failure counters and the circuit breaker tally are updated.
- **Cursor Impact**: Because `scan.cursor` was never returned, the target's in-memory cursor **remains unchanged**. The next cycle retries from the previous cursor position. Isolation ensures that a failure in one contract (e.g. `squad`) does not prevent other contracts (e.g. `market`) from scanning.

### 2. Telegram Delivery Failure
- **What happens**: When `sendMessage` fails (e.g. 429 rate limit or network outage), `sendWithRetry` retries with bounded exponential backoff (up to 3 attempts).
- **Dead-Letter Queue**: If retries are exhausted, the event is enqueued into the dead-letter queue (when `DEAD_LETTER_FILE` is configured). If DLQ is disabled, the notification is dropped.
- **Cursor Impact**: **The cursor advances normally.** The cursor commits the page position even when notification delivery is partial or failed. This prevents a broken chat configuration, revoked bot token, or unparseable text from permanently stalling poller progress or spamming upon recovery.

### 3. Malformed XDR / Event Data
- **What happens**: `decodeEvent()` wraps XDR parsing in try/catch blocks. If event topics or data contain unparseable or malformed XDR, `decodeEvent()` never throws; instead, it outputs a `DecodedEvent` with payload `{ name: "unknown", ... }`.
- **Handling**: `notify()` inspects the payload name. If `"unknown"`, it increments `eventsSkipped`, logs the skip with safe bounded metadata, and records an audit entry.
- **Cursor Impact**: **The cursor advances normally.** Malformed events do not hold back the cursor or crash the scanning loop.

### 4. Mid-Cycle Shutdown (SIGINT / SIGTERM)
- **What happens**: `poller.shutdown()` sets `status.stopping = true` and grants a bounded grace period (`shutdownTimeoutMs`, default 10s) for the active `cycleSettled` promise to resolve.
- **Notification Drain**: Inside `notify()`, checking `status.stopping` causes any pending notifications in the batch that have not yet started to be dropped immediately rather than waiting for slow network retries.
- **Cursor Impact**: In the `finally` block of the cycle, `saveCursors("shutdown")` flushes all updated cursors and the dedup window to disk. If the cycle completed scanning, the new cursor position is persisted. If interrupted before scanning finished, the previously saved cursor remains on disk. On restart, the poller resumes from the cleanly persisted cursor position without duplicating processed events.
