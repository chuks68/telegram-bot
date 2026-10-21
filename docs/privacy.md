# Data and Privacy Notice

This document describes what the bot stores and logs for operators who run it in public channels.

## What the bot stores

The bot reads only public chain data. It does not hold signing keys or any credentials that can sign transactions.

### Files persisted to disk

#### Cursor file (`CURSOR_FILE`, default `./data/cursor.json`)

- **What it contains**: Per-contract state tracking, including:
  - Cursor strings (opaque ledger position markers, not sensitive)
  - Last event ledger numbers (public chain data)
  - Recent event ids for deduplication (public chain identifiers)
- **Retention**: Persisted indefinitely; grows with use as new event ids are added to the deduplication window
- **Redaction**: No secrets are stored; cursor strings are opaque ledger positions, not keys or tokens
- **How to delete**: Stop the bot, delete the file, and restart (resumes from the `START_LOOKBACK_LEDGERS` lookback window)

#### Dead-letter file (`DEAD_LETTER_FILE`, default `./data/dead-letter.json`)

- **What it contains**: Failed notification messages that exhausted in-cycle retries:
  - Already-formatted MarkdownV2 notification text (truncated to 4,000 characters)
  - Redacted error messages (bot tokens, secrets, and URLs are removed)
  - Ledger numbers, event names, and contract sources (public chain data)
  - Attempt counts
- **Retention**: Bounded by `DEAD_LETTER_MAX` (default 100); oldest entry is dropped when the queue is full
- **Redaction**: Error messages pass through redaction rules that remove bot tokens, secret strkeys, URLs, and credential-bearing query strings. Bot tokens are explicitly scrubbed from recorded errors
- **How to delete**: Stop the bot, delete the file, and restart (replays are lost; the cursor has already advanced)

#### Audit file (`AUDIT_FILE`, default `./data/audit.jsonl`)

- **What it contains**: Append-only JSONL audit trail of operational events:
  - Event kinds (boot, shutdown, scan failures, send failures, etc.)
  - Timestamps
  - Contract sources (`market` or `squad`)
  - Redacted detail strings (clamped to 240 characters)
- **Retention**: Append-only; grows indefinitely with each event. Manual cleanup is required to prune old entries
- **Redaction**: All detail strings pass through redaction rules that remove:
  - Telegram bot tokens
  - Secret/seed strkeys (S…, D…, B…, T…)
  - URLs (which may embed tokens in query strings)
  - Any remaining ≥40-character opaque token
  - Chat ids and Telegram user ids (when they appear in error text)
- **How to delete**: Stop the bot, delete the file, and restart (historical audit data is lost)

#### Status file (`STATUS_FILE`, default `./data/status.json`)

- **What it contains**: Machine-readable status snapshot written after each poll cycle:
  - Contract ids (public chain data)
  - Network label (testnet/mainnet/futurenet/custom)
  - RPC URL (public endpoint)
  - Redacted chat id (only sign + last 4 digits for numeric ids, or `@` + first character for `@username`)
  - Truncated error messages (max 300 characters)
  - Poller counters (cycles, notifications sent/failed, etc.)
- **Retention**: Overwritten each cycle; no growth
- **Redaction**: Chat ids are redacted to a coarse shape (`…1234` or `@x…`). Error messages are truncated and may contain no secrets
- **How to delete**: Stop the bot, delete the file, and restart (regenerated on the next cycle)

#### Instance lock file (`INSTANCE_LOCK_FILE`, default `./data/poller.lock`)

- **What it contains**: Filesystem lock to ensure only one bot process runs at a time. Contains a process ID and timestamp
- **Retention**: Removed when the bot exits cleanly. May remain if the process crashes (manual cleanup required)
- **Redaction**: Contains only process ID and timestamp; no secrets
- **How to delete**: Stop the bot, delete the file, and restart. If the file is stale (process no longer running), the bot may refuse to start until it is removed

#### CSV output file (`CSV_OUTPUT_FILE`, default `./data/scanner_output.csv`)

- **What it contains**: Not currently used by the bot. Configured for a standalone scanner tool that is not implemented
- **Retention**: Not applicable (unused)
- **Redaction**: Not applicable (unused)
- **How to delete**: Not applicable (unused)

### In-memory buffers

#### Log buffer (`LOG_BUFFER_LINES`, default 500)

- **What it contains**: Ring buffer of recent console lines:
  - Bot log output (errors, warnings, info)
  - May include chat ids and Telegram user ids in error text
- **Retention**: In-memory only; lost on process restart. Bounded size (default 500 lines, configurable via `LOG_BUFFER_LINES`; set to 0 to disable)
- **Redaction**: Before storage, log lines are redacted to remove:
  - Bot tokens
  - Chat ids
  - Full-precision Stellar strkeys (G…/C…, 56 characters) are shortened to first 4 + `…` + last 4 (e.g., `GDV6…PKZI`)
- **How to delete**: Set `LOG_BUFFER_LINES=0` to disable capture, or restart the process to clear the buffer

## What the bot does NOT store

- **No signing keys**: The bot holds no private keys and signs nothing
- **No bot tokens in logs**: Bot tokens are redacted from all logs, error messages, and persisted files
- **No payment amounts**: Notification messages are formatted with amounts displayed, but amounts are not stored separately in files
- **No Telegram user IDs**: User IDs may appear transiently in log lines (which are redacted) but are not persisted to disk

## How to delete all stored data

To fully reset the bot's state:

1. Stop the bot
2. Delete the following files (if they exist):
   - `./data/cursor.json` (or your configured `CURSOR_FILE`)
   - `./data/dead-letter.json` (or your configured `DEAD_LETTER_FILE`)
   - `./data/audit.jsonl` (or your configured `AUDIT_FILE`)
   - `./data/status.json` (or your configured `STATUS_FILE`)
   - `./data/poller.lock` (or your configured `INSTANCE_LOCK_FILE`)
3. Restart the bot

The bot will resume from the `START_LOOKBACK_LEDGERS` lookback window (default 60 ledgers) and begin fresh cursor tracking.

## Retention policy

- **Cursor file**: Indefinite (required for resumption without gaps)
- **Dead-letter file**: Bounded (max entries), oldest dropped when full
- **Audit file**: Indefinite (append-only; manual cleanup required)
- **Status file**: Overwritten each cycle (no growth)
- **Instance lock file**: Removed on clean exit; stale lock may require manual removal
- **Log buffer**: In-memory only, bounded size, lost on restart

## Redaction rules

The bot applies the following redaction rules to all operator-facing text (logs, audit trail, status file, error messages):

- Telegram bot tokens (`123456789:AA…`) → `[redacted:bot token]`
- Secret/seed strkeys (`S[A-Z2-7]{55}`) → `[redacted:secret key]`
- URLs → `[redacted:url]`
- Any ≥40-character opaque token (except public G…/C… strkeys) → `[redacted:long token]`
- Credential-bearing query strings (`token=…`, `authorization: …`) → redacted
- Chat ids in status file → coarse shape only (`…1234` or `@x…`)
- Full Stellar strkeys in logs → shortened form (`GDV6…PKZI`)

## Compliance notes

- The bot reads only public blockchain data via Soroban RPC
- No personal data is collected beyond Telegram chat/user IDs, which are redacted where possible
- No data is transmitted to third-party services beyond the configured Stellar RPC endpoints and Telegram API
- Operators are responsible for ensuring their deployment complies with applicable privacy regulations for their jurisdiction
