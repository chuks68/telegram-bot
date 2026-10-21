# Telegram API Troubleshooting

Quick reference for operators mapping raw Telegram error messages to a fix.
Every fix here is safe to perform without access to production secrets.

---

## Error table

| Error text (as logged or seen in `/status`) | HTTP / code | Likely cause | Fix |
|---|---|---|---|
| `Unauthorized` / `401 Unauthorized` | 401 | `BOT_TOKEN` is wrong, revoked, or malformed. | Verify the token shape with `/health` → config provenance. Generate a fresh token via [@BotFather](https://t.me/BotFather) (`/revoke` then `/token`), update `BOT_TOKEN` in your environment, and restart the process. |
| `Forbidden: bot was kicked from the group chat` | 403 | The bot was removed from the target group. | Re-add the bot to the chat, then confirm the `CHAT_ID` (or `MARKET_CHAT_ID` / `SQUAD_CHAT_ID`) is still correct. Restart the process after the bot is present again. |
| `Forbidden: bot was blocked by the user` | 403 | A DM-style chat ID is configured but the recipient has blocked the bot. | Unblock the bot from the Telegram account, or switch to a group/channel chat ID where the bot has posting rights. |
| `Bad Request: chat not found` | 400 | The configured `CHAT_ID` does not exist or the bot has never been a member of that chat. | Forward any message from the target chat to [@userinfobot](https://t.me/userinfobot) to confirm the numeric chat ID. Update the relevant `*_CHAT_ID` environment variable to match, then restart. |
| `Bad Request: can't parse entities` / `can't find end of the entity` | 400 | A contract string field contained MarkdownV2 reserved characters that the formatter did not escape correctly. The notifier retries automatically in plain text when a `plainText` fallback is available. | No action needed if the plain-text fallback delivered the message (check the log for `retrying as plain text`). If the fallback also failed, file a bug with the raw event data from `/export`. |
| `Too Many Requests: retry after N` | 429 | Telegram is rate-limiting the bot. This happens after a burst of notifications or during a large replay. | The poller's dead-letter queue parks the message and retries it automatically on later cycles. Check `/status` for `Parked sends` and wait. If the burst was caused by a deliberate replay, slow it down with `MAX_NOTIFICATIONS_PER_CYCLE`. |
| `Bad Request: message is too long` | 400 | A single notification chunk exceeded Telegram's 4096-character `sendMessage` limit. | The notifier splits oversized payloads automatically. If this error still appears it means a single event produced a chunk that cannot be split further. Check the contract string fields for unexpectedly large values and file a bug. |
| `Bad Request: message text is empty` | 400 | The formatter returned an empty or whitespace-only string. The notifier skips these before calling the API and increments `notifierSkips.emptyText`. | Check logs for `[notifier] skipped empty message` with the source and ledger. This is a formatter bug; file an issue with the event data from `/export`. |
| `Network request for … failed` / `ECONNREFUSED` / `ETIMEDOUT` | network | The process cannot reach `api.telegram.org`. | Check outbound connectivity from the host. The send will be retried on the next cycle; the dead-letter queue parks it in the meantime. |
| `BOT_TOKEN is wrapped in quotes` / `BOT_TOKEN contains whitespace` | startup | The token value was pasted with surrounding quotes or trailing whitespace. | Remove the quotes or whitespace from the environment variable. See `validateBotTokenShape` in `src/bot.ts` for all validated shapes. |
| `getUpdates … conflict: terminated by other getUpdates request` | 409 | Two bot processes are running with the same token. | Stop all but one instance. If using long-polling (the default), only a single process may poll at a time. See [ADR-0004](adr/0004-long-polling-with-optional-webhook.md). |
| `Forbidden: bot is not a member of the channel chat` | 403 | A channel ID is configured but the bot was never added as an administrator. | Add the bot to the channel as an admin with the "Post Messages" right, then restart. |

---

## Diagnostic commands

**Check bot and chat configuration**

```bash
/health
```

Prints configuration provenance (which source supplied each setting, never
the values themselves) and the current poller state. Use this first — it
pinpoints whether a token or chat ID problem is active without echoing secrets.

**Check live error and send counters**

```bash
/status
```

Shows `failed sends`, `Parked sends`, consecutive failures, and any
per-target last error. Compare `notificationsSent` and `notificationsFailed`
across two `/status` calls to confirm whether sends are recovering.

**Inspect recent log lines**

```bash
/export
```

Exports a bounded, redacted ring of recent log lines. Look for
`[notifier]` lines to trace the MarkdownV2-to-plain-text retry path,
and for `send failed … after retries` to identify permanently parked messages.

**Inspect the dead-letter queue**

```bash
cat data/dead-letter.json | jq '.entries | length'
```

See [dead-letter-queue.md](dead-letter-queue.md) for field descriptions and
how to clear or replay entries manually.

---

## 401 vs 403: quick distinction

| Code | Message fragment | Meaning |
|---|---|---|
| 401 | `Unauthorized` | The token itself is invalid or revoked. |
| 403 | `bot was kicked` / `bot was blocked` / `not a member` | The token is valid but the bot lacks access to the specific chat. |

A 401 means rotating the token is mandatory. A 403 means fixing chat membership
or permissions, with the same token if it is otherwise healthy.

---

## Related documentation

- [Incident Runbook](incident-runbook.md) — end-to-end recovery procedures for RPC, Telegram, and cursor failures
- [Dead-Letter Queue](dead-letter-queue.md) — parked send format, retry limits, and manual queue management
- [Configuration Reference](configuration-reference.md) — all environment variables including `BOT_TOKEN`, `CHAT_ID`, and `MAX_NOTIFICATIONS_PER_CYCLE`
- [ADR-0002: MarkdownV2 with plain-text fallback](adr/0002-markdownv2-with-plain-text-fallback.md) — rationale for the parse-error retry behaviour
