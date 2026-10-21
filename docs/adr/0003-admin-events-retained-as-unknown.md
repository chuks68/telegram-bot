# ADR 0003: Retaining Admin and Unrecognized Events Without Notifying

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The Soroban contracts (`mimir-market` and `mimir-squad`) emit both user-facing lifecycle events (claims, challenges, resolutions, settlements, deposits, withdrawals) and contract administration or future events (such as `oracle_changed`, `ownership_transferred`, `agent_attributed`, `fee_accrued`, `fee_policy_*`, `admin_*`, or new event types added in future contract upgrades). Additionally, remote RPC responses are untrusted and could contain unexpected topic shapes or oversized XDR payloads.

If the decoder threw an exception on unrecognized or administrative events, a routine contract admin action or a forward-compatible contract upgrade would crash the poll loop. Conversely, if the decoder silently dropped unrecognized or non-notifiable events by returning `null` or filtering them out before returning to the poller, operators would have no visibility in logs, metrics, or audit trails that on-chain events were observed and skipped.

## Decision

1. **`decodeEvent()` never throws:** Every raw Soroban event returned by the scanner is decoded into a `DecodedEvent` carrying normalized `EventMeta` and a typed `EventPayload`.
2. **Retain unrecognized or un-notifiable events as `UnknownPayload`:** Any event whose name has no notification decoder (including unrecognized admin events or future contract events) or whose topics/XDR value fail validation or size caps (`MAX_DECODED_EVENT_XDR_BYTES`) is returned with `payload: { name: "unknown", eventName, reason }` (`UnknownPayload`) rather than dropped or thrown.
3. **Decode recognized admin events for audit and skip Telegram delivery:** Known administrative events (`oracle_changed`, `ownership_transferred`, `agent_attributed`, `fee_accrued`, `fee_policy_*`, `admin_*`) are decoded by `decodeAdmin()` into `AdminPayload` (while unrecognized event names fall through to `UnknownPayload`). In `src/poller.ts`, both `isAdminPayload(event.payload)` and `event.payload.name === "unknown"` are skipped for Telegram delivery, increment `eventsSkipped`, and emit bounded log and audit entries (`toAdminAuditRecord` for admin events; `event_skipped` audit and structured log entries for `unknown` events).

## Consequences

### Positive

- **Forward compatibility:** Deploying a contract upgrade that emits new event types or new admin actions never crashes the decoder or stalls the poller.
- **Observable skips instead of silent drops:** Keeping `UnknownPayload` and `AdminPayload` in the decoded event stream allows `src/poller.ts` to count every skipped event in `eventsSkipped`, record bounded diagnostics in the audit log, and advance the cursor cleanly.
- **No operational noise in public channels:** Administrative contract maintenance is recorded in operator logs and audit trails without spamming end-user Telegram channels.

### Negative / Trade-offs

- **Callers must handle non-notifiable payload variants:** Downstream consumers of `DecodedEvent` (such as `notify()` in `src/poller.ts` and `formatEvent()` in `src/notifications/format.ts`) must explicitly branch on or guard against `unknown` and admin payloads rather than assuming every decoded event produces a Telegram message.

## Code References

- [`src/stellar/decode.ts`](../../src/stellar/decode.ts) — `UnknownPayload`, `AdminPayload`, `decodeAdmin()`, `decodeEvent()`, `isAdminPayload()`, and `toAdminAuditRecord()`.
- [`src/poller.ts`](../../src/poller.ts) — `notify()` handling `isAdminPayload(event.payload)` and `event.payload.name === "unknown"` by logging, auditing, incrementing `eventsSkipped`, and advancing the cursor.
- [`src/notifications/format.ts`](../../src/notifications/format.ts) — `formatEvent()` returning `null` for `unknown` and admin payloads.
