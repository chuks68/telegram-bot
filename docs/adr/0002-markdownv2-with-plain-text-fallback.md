# ADR 0002: MarkdownV2 Formatting with Plain-Text Fallback

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The bot formats on-chain events and command responses for Telegram channels and chats. Telegram offers legacy `Markdown`, `HTML`, and `MarkdownV2` parse modes:

- Legacy `Markdown` silently accepts malformed entity input and renders broken or garbled text in the chat.
- `MarkdownV2` strictly validates entity syntax and rejects malformed messages with HTTP 400 (`"Bad Request: can't parse entities..."`).

While strict validation in `MarkdownV2` ensures formatting bugs surface immediately rather than producing mangled messages, contract events include untrusted user-supplied strings (such as claim summaries, categories, and squad market questions). Even with escaping via `escapeMd()`, an unexpected entity edge case or message split could cause Telegram to reject a `MarkdownV2` payload with a 400 parse error. Retrying the exact same `MarkdownV2` payload in `sendWithRetry()` would fail identically and drop the notification.

## Decision

1. **Use `MarkdownV2` as the primary format:** All formatted notifications (`formatEvent`) and command replies (`TELEGRAM_OPTIONS`) use `parse_mode: "MarkdownV2"`, escaping every interpolated dynamic value through `escapeMd()`.
2. **Pre-compute a plain-text twin for notifications:** For every notifiable event in `src/poller.ts`, the poller generates both the `MarkdownV2` message (`formatEvent`) and a plain-text rendering (`formatPlainTextEvent`) attached via `SendExtra.plainText`.
3. **Retry once as plain text on entity parse errors only:** In `createNotifier()` (`src/bot.ts`), if `bot.api.sendMessage` fails and `isMarkdownParseError(err)` identifies a Telegram HTTP 400 entity parse rejection (`"can't parse entities"` or `"can't find end of the entity"`) and `extra.plainText` is present, the notifier logs a bounded, secret-redacted warning and sends `extra.plainText` **once** without a `parse_mode` (preserving `reply_markup` and `link_preview_options`).
4. **Propagate all other errors unchanged:** Rate limits (429), authentication errors (401), chat errors, network failures, or a failure on the plain-text fallback itself are rethrown so the poller's `sendWithRetry()` and failure accounting operate normally.

## Consequences

### Positive

- **Clean visual formatting with strict escaping:** Normal notifications render rich `MarkdownV2` typography (bold headers, inline code for contract IDs and addresses, italics for metadata) without silent corruption.
- **Resilience against entity-parse edge cases:** An unexpected `MarkdownV2` entity rejection degrades gracefully to readable plain text in a single fallback call rather than losing the notification or burning retry backoff cycles.
- **No infinite fallback loops:** The plain-text retry omits `parse_mode`, so it cannot trigger another entity parse error, and runs at most once per notification.

### Negative / Trade-offs

- **Dual formatting templates:** Every notification type must maintain both a `MarkdownV2` formatter (`NOTIFICATION_MD` / `formatEvent`) and a plain-text formatter (`NOTIFICATION_PLAIN` / `formatPlainTextEvent`).
- **Strict escaping discipline required:** Contributors authoring static `MarkdownV2` strings must escape all reserved characters (`_*[]()~`>#+-=|{}.!\`).

## Code References

- [`src/bot.ts`](../../src/bot.ts) — `TELEGRAM_OPTIONS`, `SendExtra`, `isMarkdownParseError()`, and `createNotifier()`.
- [`src/notifications/format.ts`](../../src/notifications/format.ts) — Module header comment explaining `MarkdownV2` over legacy `Markdown`, `escapeMd()`, `formatEvent()`, and `formatPlainTextEvent()`.
- [`src/poller.ts`](../../src/poller.ts) — `notify()` constructing `text` (`formatEvent`) alongside `plainText` (`formatPlainTextEvent`) in `SendExtra`.
