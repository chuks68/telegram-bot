# Replaying Missed Ledgers

Operational procedure for recovering missed events and replaying ledger ranges with the Mimir replay CLI (`npm run replay`).

---

## 1. Operating Principles & Safety Guarantees

* **The Stellar blockchain is the source of truth.** The notifier is read-only and never holds signing keys, submits transactions, or modifies on-chain state.
* **Replay is decoupled from the live poller.** Running a replay **never reads from, writes to, or locks** the live cursor file (`CURSOR_FILE`, default `data/cursor.json`). The running daemon's cursor state and scheduling are untouched.
* **Safe by default (dry-run):** The CLI runs in dry-run mode unless `--send` is explicitly provided. Dry-run mode requires zero Telegram credentials (`BOT_TOKEN` and `TELEGRAM_CHAT_ID` are not needed).
* **Bounded execution:** The walk is constrained per contract by `--pages` (default 20) and notification output is capped by `--cap` (default `MAX_NOTIFICATIONS_PER_CYCLE` or 20).
* **Sanitized output:** Progress messages and error logs are scrubbed via centralized redaction (`src/redact.ts`); bot tokens and credentials never appear in output or JSON reports.

---

## 2. Identifying a Missing Ledger Range

When a bot encounters downtime, host migration, network partitions, or an extended outage, events may have closed on-chain without being announced in Telegram.

### 2.1 From the `/health` Endpoint or `/status` Command

Query the local health endpoint:

```bash
curl -s http://127.0.0.1:8787/health | jq .poller
```

Or issue the `/status` operator command in the Telegram chat. Inspect the following fields:

1. **`lastRestartGap`:** When a restart occurs after downtime exceeding the RPC's retention floor, the poller records the unrecoverable gap:
   ```json
   "lastRestartGap": {
     "at": "2026-10-17T14:20:00.000Z",
     "source": "market",
     "cursorLedger": 4226000,
     "oldestLedger": 4226500,
     "missedLedgers": 500
   }
   ```
2. **`targets[].lastEventLedger`:** The ledger sequence of the last successfully processed event for each contract (`market` and `squad`).
3. **`targets[].rewindFromLedger`:** The ledger from which a target resumed following an automatic floor rewind.
4. **`latestLedger` and `oldestLedger`:** The current chain tip and the oldest ledger retained by the Soroban RPC.

### 2.2 From Process Logs

Search the console logs or exported ring (`GET /health/diag` or `/export`):

```text
[poller] restart gap detected for market: cursor at ledger 4226000 is below retained floor 4226500 (500 ledgers unreadable)
[poller] market: scan failed: ...
```

### 2.3 Calculating `--from` and `--to`

* **`--from` (Start):** Set to `lastEventLedger + 1` (or the last known good ledger before the incident). If the cursor token string is known (e.g. `18152504818786304-0`), it can also be passed directly to `--from`.
* **`--to` (End):** Set to the ledger where the poller resumed healthy processing, or omit `--to` to scan up to the current chain tip.

---

## 3. Supported CLI Flags & Options

The replay CLI is invoked via `npm run replay -- [flags]` or entrypoint `src/replay-cli.ts`.

| Flag | Type / Values | Description | Default |
| --- | --- | --- | --- |
| `--from` | `<ledger \| cursor>` | Starting ledger sequence or opaque cursor token (`<TOID>-<index>`). **Required.** | None |
| `--to` | `<ledger>` | Ending ledger sequence (inclusive upper bound). | Chain tip (`window.latestLedger`) |
| `--contract` | `market \| squad` | Restrict replay to a single contract. | Both contracts (`market` and `squad`) |
| `--send` | Boolean flag | Actually dispatch messages to Telegram. Requires valid Telegram credentials in `.env` or process environment. | `false` (dry-run mode is active by default) |
| `--dry-run` | Boolean flag | Explicit dry-run flag accepted by CLI parser. Dry-run is active whenever `--send` is omitted. | `true` |
| `--pages` | `<number>` | Maximum RPC pages to walk per contract. Must be $\ge 1$. | `20` (`EVENT_MAX_PAGES`) |
| `--cap` | `<number>` | Maximum notifications to send/count per contract. | `config.maxNotificationsPerCycle` in `--send` mode; `20` in dry-run mode |
| `--show` | `<number>` | Number of individual event dispositions to include in the report log. | `0` (summaries only; eventLog is also included during dry-run) |
| `--json` | Boolean flag | Write a single JSON report (`mimir-replay-v1`) to `stdout`. Logs route to `stderr`. | `false` |
| `--mock` | Boolean flag | Select the local mock profile (`MIMIR_PROFILE=mock`). | `false` |

### Exit Codes

* **`0`:** Scan completed successfully (even if some events were skipped, deduplicated, or capped).
* **`1`:** Fatal runtime error (RPC unreachable, invalid network passphrase, or missing config in `--send` mode).
* **`2`:** Usage error (missing `--from`, non-numeric or negative ledger, `--to` earlier than `--from`, or invalid `--contract`).

---

## 4. Step-by-Step Recovery Procedure

### Step 1: Rehearse with Dry-Run Mode

Always run a dry-run first to verify the number of events, test RPC connectivity, and confirm range clamping.

```bash
npm run replay -- --from 4226500 --to 4226800
```

To inspect specific events without spamming terminal output, use `--show`:

```bash
npm run replay -- --from 4226500 --to 4226800 --show 10
```

To produce machine-readable JSON for scripting or incident audits:

```bash
npm run replay -- --from 4226500 --to 4226800 --json > replay-plan.json
```

### Step 2: Review the Replay Report & Boundary Warnings

Examine the progress output on `stderr` (or human logs on `stdout`):

```text
[replay] network   testnet · rpc https://soroban-testnet.stellar.org
[replay] from      4226500  to 4226800
[replay] mode      dry-run (use --send to deliver to Telegram)
[replay] market: pages=2 events=4 sent=4 skipped=0 capped=0 admin=0 duplicates=0 truncated=false
[replay] squad: pages=1 events=0 sent=0 skipped=0 capped=0 admin=0 duplicates=0 truncated=false
[replay] done  events=4 sent=4 skipped=0 capped=0 admin=0 duplicates=0
```

#### Boundary Warnings to Check

1. **Retained Floor Clamping:**
   ```text
   [replay] market: --from 4100000 is below the retained floor; clamped up to 4226500
   ```
   If `--from` is older than `oldestLedger`, the RPC has already pruned those ledgers. Replay automatically clamps to the floor (see [Section 6](#6-rpc-history-retention-limits--pruned-ledgers)).
2. **Chain Tip Clamping:**
   ```text
   [replay] market: --to 9999999 is ahead of the chain tip; clamped to 4228000
   ```
   `--to` values beyond current chain tip are clamped to `window.latestLedger`.
3. **Range Inversion:**
   `--to` before `--from` is rejected immediately with exit code `2`.

### Step 3: Execute the Live Replay

Once the dry-run confirms the event counts and targets, execute live delivery by adding `--send`:

```bash
npm run replay -- --from 4226500 --to 4226800 --send
```

If only one contract had missed events, restrict the replay with `--contract`:

```bash
npm run replay -- --from 4226500 --to 4226800 --contract market --send
```

For wider ranges spanning many pages, expand the page budget:

```bash
npm run replay -- --from 4226500 --to 4230000 --pages 100 --cap 100 --send
```

### Step 4: Verify Delivery & Confirm Poller Cursor

1. **Verify Telegram Channel:** Confirm formatted event messages arrived in the chat with correct markdown formatting and explorer buttons.
2. **Confirm Live Poller Cursor State:** Verify that running replay did **not** overwrite or alter the live poller's cursor:
   ```bash
   curl -s http://127.0.0.1:8787/health | jq .poller.targets
   ```
   The live bot continues polling its independent cursor window without disruption.

---

## 5. Event Filtering, Deduplication, and Edge Cases

The replay engine applies identical decoding and deduplication rules as the live poller:

1. **Admin Events:** Payloads matching `isAdminPayload` (admin upgrades, configuration updates) are logged to console but skipped (`entry.skipReason = "admin"`). They are never sent to Telegram.
2. **Unknown Events:** Undecodable payloads or events from newer contract versions are logged and skipped (`entry.skipReason = "unknown"`).
3. **Deduplication:** An in-memory `EventDedupWindow` (capacity 256) tracks the canonical `eventKey` across overlapping pages. Duplicate event IDs returned across page boundaries are counted in `duplicates` and suppressed.
4. **Cap Protection:** If the count of sent notifications reaches `--cap`, subsequent events are skipped with `skipReason = "cap"` to prevent Telegram rate-limiting (HTTP 429).
5. **Send Errors:** An individual Telegram dispatch failure is logged and recorded as skipped (`skipReason = "send-error"`). It does not abort the remaining replay walk.

---

## 6. RPC History Retention Limits & Pruned Ledgers

Soroban RPC nodes maintain a rolling window of history (typically ~120,960 ledgers, or approximately 7 days on Testnet).

* **The Retained Floor:** `server.getHealth()` returns `oldestLedger`. Requesting a start ledger below `oldestLedger` is refused by the RPC.
* **Automatic Clamping (`clampStartLedger`):** The replay engine invokes `clampStartLedger` (`src/stellar/replay.ts`) to clamp `--from` up to `oldestLedger`, sets `startClamped: true` on the walk summary, and emits a boundary warning.
* **When Missed Ledgers are Below the Floor:**
  If an outage lasted longer than the retention window:
  1. The replay CLI can only recover events from `oldestLedger` to the recovery point.
  2. Events prior to `oldestLedger` **cannot be recovered via Soroban RPC**.
  3. For archival recovery prior to `oldestLedger`, operators must consult an external archival indexer or Stellar Expert block explorer; the Soroban RPC itself cannot serve pruned event history.

---

## 7. Rehearsing Locally with Mock RPC

Operators and contributors can rehearse the entire recovery procedure offline without hitting Testnet or requiring Telegram credentials.

### Terminal 1: Start the Local Mock RPC

```bash
npm run mock:rpc
```
*Starts an in-process Soroban JSON-RPC mock on loopback (`http://127.0.0.1:8420`) with preloaded market and squad event fixtures.*

### Terminal 2: Run Replay Against the Mock

```bash
npm run replay:mock -- --from 900 --to 1000
```
*(Or pass `--mock` directly: `npm run replay -- --from 900 --to 1000 --mock`)*

For machine-readable verification in monitoring or operational scripts, append `--json`:
```bash
npm run replay:mock -- --from 900 --to 1000 --json
```

### Verify Output

```text
[replay] network   mock · rpc http://127.0.0.1:8420
[replay] from      900  to 1000
[replay] mode      dry-run (use --send to deliver to Telegram)
[replay] done  events=...
```

To stop the mock server, send `Ctrl+C` in Terminal 1.
