# Threat Model: Mimir Telegram Notifier

This document establishes the security baseline for the Mimir Telegram Notifier. It identifies primary assets, threat actors, trust boundaries, and details a STRIDE threat matrix mapping threats to existing mitigations and open issues.

---

## 1. System Overview & Architecture

The Mimir Telegram Notifier is a read-only bridge service that monitors Soroban smart contract events on Stellar (specifically `mimir-market` and `mimir-squad`) and publishes formatted notifications to Telegram channels or chats. Additionally, the service provides an administrative interface over Telegram commands and an HTTP health check/webhook server.

```
       [Stellar Soroban RPC] (External, Untrusted/Semi-trusted)
                 |
                 | TLS / JSON-RPC getEvents & getHealth
                 v
   +-------------------------------------------------------------+
   | TRUST BOUNDARY: Network & RPC Ingestion                     |
   |   - stellar/events.ts, stellar/client.ts                    |
   |   - Bounds & validation: stellar/decode.ts                  |
   +-------------------------------------------------------------+
                                 |
                                 v
   +-------------------------------------------------------------+
   | NOTIFIER CORE ENGINE                                        |
   |   - Poller (src/poller.ts)                                  |
   |   - Redaction & Sanitization (src/redact.ts, format.ts)     |
   |   - Storage / Cursors (data/cursor.json, atomic writes)     |
   |   - Instance Lock (src/instanceLock.ts)                     |
   +-------------------------------------------------------------+
         |                                           ^
         | HTTP / Health & Webhook                   | Telegram Updates
         v                                           | (Polling / Webhook)
   +-----------------------------+        +----------------------+
   | TRUST BOUNDARY: HTTP        |        | TRUST BOUNDARY: TG   |
   |   - src/health.ts           |        |   - isOperator check |
   |   - Loopback or Webhook     |        |   - validateCallback |
   +-----------------------------+        +----------------------+
                 ^                                   ^
                 |                                   |
           [Local Supervisor /                [Telegram Users /
            Prometheus Scraper]                Admins / Attackers]
```

---

## 2. Assets

The assets requiring protection against unauthorized disclosure, tampering, or disruption include:

1. **Authentication Secrets & Tokens**
   - Telegram Bot API token (`BOT_TOKEN`).
   - Telegram Webhook secret token (`X-Telegram-Bot-Api-Secret-Token`).
   - Potential user credentials, seed strkeys, or URL userinfo passed in environment/config.
2. **Operational State & Cursor Integrity**
   - Cursor persistence files (`data/cursor.json` or path specified by `CURSOR_FILE`).
   - Dead-letter queue entries (`dead-letter.jsonl` / `deadLetter.ts`).
   - Instance lock files preventing dual execution (`instanceLock.ts`).
3. **Execution Availability & Resource Integrity**
   - Node.js event loop capacity and CPU/memory headroom.
   - Telegram message rate limits (preventing bot account throttling or 429 bans).
   - Disk space against unbounded error logging or cursor inflation.
4. **Data Authenticity & Notification Accuracy**
   - Correct translation of Soroban events into Telegram alerts without spoofing, truncation, or omission.
5. **Operational Privacy**
   - Target chat IDs (`TELEGRAM_CHAT_ID`, `ALLOWED_CHAT_IDS`).
   - Operator user identity (`OPERATOR_TELEGRAM_USER_ID`).
   - Unredacted stack traces or internal environment variables.

---

## 3. Threat Actors

- **Untrusted Telegram User**: Any Telegram user who can send direct messages or invoke commands/callbacks on the bot in private or shared group chats.
- **Malicious Smart Contract / Rogue Issuer**: An on-chain actor or compromised contract deploying custom payloads, malformed XDR, or oversized string fields to crash or spam downstream indexers.
- **Compromised / Malicious Soroban RPC Endpoint**: A rogue or man-in-the-middle RPC provider returning forged events, circular cursors, or bloated JSON-RPC responses.
- **Untrusted Local Network Actor**: An attacker on the local host or adjacent container/pod attempting to probe or flood the HTTP server ports.
- **Unprivileged Host User**: A user or compromised sidecar process on the same machine attempting to read or tamper with cursor state files or read process environment variables.

---

## 4. Trust Boundaries

1. **TB-1: Stellar Soroban RPC Boundary**
   - Communication across the network via HTTPS to external RPC endpoints. All event XDR and pagination metadata (`cursor`, `oldestLedger`, `latestLedger`) cross this boundary.
2. **TB-2: Telegram Ingress Boundary (Commands & Callback Queries)**
   - Untrusted JSON updates sent from Telegram servers (via long-polling `getUpdates` or incoming HTTP `POST /telegram-webhook`).
3. **TB-3: Telegram Egress Boundary (Notifications & Formatting)**
   - Outbound MarkdownV2 text posted to Telegram chats. Unsanitized strings could break parser grammar or trigger injection attacks.
4. **TB-4: HTTP Management Boundary (`src/health.ts`)**
   - Inbound HTTP requests for `/health`, `/health/diag`, and `/telegram-webhook`.
5. **TB-5: Local Filesystem Boundary**
   - Storage of state snapshots, cursor checkpoints, lockfiles, and dead-letter queue records.

---

## 5. STRIDE Threat Matrix

The table below classifies threats across the STRIDE model, mapping each threat to existing mitigations in the codebase, or marking them as open.

| ID | STRIDE Category | Threat Description | Trust Boundary | Existing Mitigation / Code Reference | Status |
|:---|:---|:---|:---|:---|:---|
| **T-01** | **Spoofing** | Unauthorized user issues operator commands (e.g. `/pause`, `/resume`, `/drain`, `/contract`). | TB-2 | Handlers enforce operator authorization via `isOperator()` checking `ctx.from.id` against `config.operatorTelegramUserId` (`src/bot.ts`). Non-operators are rejected and unauthorized attempts are logged. | **Mitigated** |
| **T-02** | **Spoofing** | Attacker posts forged webhook updates to `POST /telegram-webhook`. | TB-4 | A cryptographic random hex token (`webhookSecret`) is generated at startup and registered with Telegram via `setWebhook` using `secret_token`; incoming requests are validated against this secret (`src/index.ts`). | **Mitigated** |
| **T-03** | **Tampering** | Attacker passes malformed, oversized, or control-character callback data to execute unexpected logic. | TB-2 | `validateCallbackData()` strictly validates callback payload format, enforces max byte length (`TELEGRAM_CALLBACK_DATA_MAX_BYTES` = 64 bytes), rejects ASCII control characters and null bytes (`[\x00-\x1F\x7F]`), and validates against known actions (`src/bot.ts`). | **Mitigated** |
| **T-04** | **Tampering** | Hostile contract emits malformed XDR or oversized strings to corrupt state or crash memory. | TB-1 | Event decoding checks wire boundaries: `assertEventXdrWithinCap` enforces `MAX_DECODED_EVENT_XDR_BYTES` (16 KiB), `MAX_EVENT_TOPIC_XDR_BYTES` (1 KiB), and native conversions truncate strings to `MAX_DECODED_STRING_CHARS` (2048 chars) (`src/stellar/decode.ts`). Unrecognized or invalid payloads fail gracefully to `{ name: "unknown" }`. | **Mitigated** |
| **T-05** | **Tampering** | Concurrent processes or sudden crash during write corrupts cursor state file (`data/cursor.json`). | TB-5 | Single instance enforced via file lock (`src/instanceLock.ts`). Cursor writes use atomic temporary-file writes (`.tmp`) followed by atomic rename (`fs.rename`), plus JSON schema validation on startup and quarantine on corruption (`src/poller.ts`). | **Mitigated** |
| **T-06** | **Repudiation** | Operator actions or configuration changes executed without audit logging. | TB-2 | Administrative commands and configuration alterations are recorded in a dedicated redacted ring buffer via `recordAudit()` (`src/audit.ts`) and viewable via `/audit` (`src/bot.ts`). | **Mitigated** |
| **T-07** | **Information Disclosure** | Bot token, private keys, or URL credentials leaked via logs, `/status`, or `/health`. | TB-3, TB-4 | Process-wide secrets registration and recursive redaction in `src/redact.ts` (`registerSecret`, `redactText`, `DEFAULT_REDACTION_RULES`). Sensitive query parameters, bearer tokens, seed strkeys, and bot tokens are scrubbed with `[REDACTED]` and clamped to bounded length (`src/redact.ts`, `src/health.ts`). | **Mitigated** |
| **T-08** | **Information Disclosure** | HTTP health endpoint exposed to public network disclosing internal diagnostics. | TB-4 | Health server defaults to binding `127.0.0.1` (`HEALTH_HOST` default `127.0.0.1`) so it is never exposed externally by default (`src/health.ts`). Detailed diagnostics (`/health/diag`) require explicit configuration and return redacted log entries. | **Mitigated** |
| **T-09** | **Information Disclosure** | Bot responds to queries or posts notifications in unauthorized Telegram chats. | TB-2 | Chat filtering via `ALLOWED_CHAT_IDS` and `isChatAllowed()` checks ensure the bot does not process commands from unauthorized groups (`src/bot.ts`). | **Mitigated** |
| **T-10** | **Denial of Service** | Flash-flood of on-chain events exhausts Telegram rate limits or freezes poller. | TB-1, TB-3 | `MAX_NOTIFICATIONS_PER_CYCLE` (default 20) caps notifications per poll cycle. Events exceeding the cap are skipped/logged and cursors advance. Deduplication window filters re-emitted events (`src/poller.ts`, `src/dedup.ts`). | **Mitigated** |
| **T-11** | **Denial of Service** | RPC node returns endless pagination loops or non-monotonic cursors. | TB-1 | Scanner enforces `EVENT_MAX_PAGES` limit (20 pages per scan) and terminates if the cursor stops advancing or reaches chain tip (`src/stellar/events.ts`). Floor clamping (`clampStartLedger`) prevents deep re-scans. | **Mitigated** |
| **T-12** | **Denial of Service** | Local HTTP server resource exhaustion via unbounded concurrent connections or large payloads on webhook. | TB-4 | Health check requests are short-circuited; webhook body parsing is handed to `grammy` with Node HTTP defaults. No custom request-rate limiting or max body size limit is enforced on raw HTTP requests. | **Open** |
| **T-13** | **Elevation of Privilege** | Attacker impersonates Telegram user ID via forward headers or webhook injection. | TB-2, TB-4 | Telegram user ID is validated from verified `Update` payloads provided by Telegram API or verified webhook token. Telegram Bot API guarantees integrity of `from.id` when communication is authentic. | **Mitigated** |
| **T-14** | **Tampering / Injection** | Raw contract data containing Telegram Markdown formatting characters alters message structure or executes link injection. | TB-3 | Text interpolations are escaped using `escapeMd()` or `sanitizeMarkdown()` in `src/notifications/format.ts` and `src/bot.ts`. | **Mitigated** |
| **T-15** | **Elevation of Privilege** | In-memory configuration modification via dynamic command injection or unauthorized API call. | TB-2 | Dynamic commands are strictly parameterized; command arguments are parsed with strict validation schemas. Bot holds no capability to execute system shell commands or modify environment variables. | **Mitigated** |
| **T-16** | **Information Disclosure / Spoofing** | DNS spoofing / MITM on Soroban RPC endpoint when communicating over insecure or unverified HTTP. | TB-1 | RPC URL configuration requires HTTPS for production environments, but plain HTTP is permitted for local development and mock scenarios without warning. | **Open** |
| **T-17** | **Tampering** | Local file permissions on state files (`cursor.json`, `dead-letter.jsonl`) permit other local OS users to modify cursor positions or inject state. | TB-5 | Files are written with Node default umask without explicit mode restrictions (`0600`). | **Open** |

---

## 6. Open Items & Candidate Issues

The following items are identified as open risks or defense-in-depth opportunities suitable for tracking as follow-up issues:

### Candidate Issue 1: Enforce Request Body Size and Timeout on HTTP Webhook Endpoint
- **Threat**: T-12 (Denial of Service on HTTP server)
- **Description**: In webhook mode (`POST /telegram-webhook`), incoming requests are delegated directly to Grammy's `webhookCallback`. If an attacker or unauthenticated client floods slow HTTP headers or sends an unbounded POST body, memory and sockets could be tied up before authentication completes.
- **Proposed Mitigation**: Implement an explicit payload length limit (e.g. 1 MiB) and an incoming socket timeout on `src/health.ts` for the webhook route.

### Candidate Issue 2: Restrict File Permissions on Persisted State and Cursors (`0600`)
- **Threat**: T-17 (Local file tampering / eavesdropping)
- **Description**: State files written by `src/poller.ts` (`data/cursor.json`), `src/deadLetter.ts`, and `src/instanceLock.ts` use default filesystem permissions dictated by the process umask (typically `0644` or `0664`). On shared hosts or multi-tenant containers, non-root users can read or alter state.
- **Proposed Mitigation**: Explicitly set file modes to `0600` (read/write by owner only) and directory modes to `0700` during atomic file creation.

### Candidate Issue 3: Warn or Disallow Insecure Plaintext HTTP for Remote RPC Endpoints
- **Threat**: T-16 (MITM / RPC spoofing)
- **Description**: `STELLAR_RPC_URL` accepts plain `http://` without restrictions. While convenient for local development, production configurations could inadvertently use plaintext HTTP across the public Internet, exposing RPC queries and enabling ledger/event spoofing.
- **Proposed Mitigation**: Add validation in `src/config.ts` to log a startup warning or require an explicit override (e.g. `ALLOW_INSECURE_RPC=true`) when non-loopback addresses use `http://`.

### Candidate Issue 4: Telegram Operator Multi-Factor / Secondary Confirmation for Destructive Commands
- **Threat**: T-01 (Operator account compromise)
- **Description**: While commands like `/drain` or `/pause` verify `isOperator()`, Telegram user accounts can be compromised via SIM swaps or session hijacking.
- **Proposed Mitigation**: Require secondary confirmation callback or one-time confirmation phrase before executing state-draining actions.
