# Architecture Decision Records

This directory captures key architectural and operational design choices in the Mimir Telegram bot so future changes do not accidentally undo deliberate trade-offs.

## Index

| ADR | Title | Status | Primary Code Path |
| --- | ----- | ------ | ----------------- |
| [0001](0001-cursor-commit-policy.md) | Cursor Commit Policy and Lossy Notification Delivery | Accepted | [`src/poller.ts`](../../src/poller.ts) |
| [0002](0002-markdownv2-with-plain-text-fallback.md) | MarkdownV2 Formatting with Plain-Text Fallback | Accepted | [`src/bot.ts`](../../src/bot.ts), [`src/notifications/format.ts`](../../src/notifications/format.ts) |
| [0003](0003-admin-events-retained-as-unknown.md) | Retaining Admin and Unrecognized Events Without Notifying | Accepted | [`src/stellar/decode.ts`](../../src/stellar/decode.ts), [`src/poller.ts`](../../src/poller.ts) |
| [0004](0004-long-polling-with-optional-webhook.md) | Telegram Long-Polling by Default with Optional Webhook Mode | Accepted | [`src/index.ts`](../../src/index.ts), [`src/health.ts`](../../src/health.ts) |

## Adding a New ADR

1. Copy [`template.md`](template.md) to `NNNN-short-title.md` using the next sequential four-digit number.
2. Fill in **Context**, **Decision**, **Consequences**, and **Code References** linking to the implementation.
3. Add the new entry to the table above.
