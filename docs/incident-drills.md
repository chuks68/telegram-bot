# Incident Drill Scenarios

Comprehensive reference and execution guide for Mimir's offline incident drills defined in [`src/drill.ts`](../src/drill.ts) and executed via [`scripts/incident-drill.mjs`](../scripts/incident-drill.mjs).

---

## 1. Overview & Operating Principles

Mimir's incident drill suite executes credential-free, offline failure simulations against loopback mocks. The suite validates that the notifier behaves correctly and predictably during critical infrastructure outages without requiring live Stellar Testnet RPC endpoints or Telegram bot tokens.

Every drill enforces Mimir's core operational invariants:

* **Stellar chain state is the single source of truth:** Telegram is an ephemeral, lossy notification sink. A failure to deliver a message never alters on-chain state, halts future event tracking, or results in unhandled process crashes.
* **Notifier is strictly read-only:** The notifier never holds signing keys, secret seed keys, or private keys, and never signs or submits Stellar transactions.
* **Zero secrets or unbounded payloads in logs/status:** Sensitive authentication data (such as `BOT_TOKEN`, private keys, or unbounded remote RPC payloads) are scrubbed and bounded by centralized redaction ([`src/redact.ts`](../src/redact.ts)).
* **Controlled cursor persistence:** Cursors follow strict version-1 schema rules, advance safely past delivered or skipped events, rewind only to verified retention floors, and fall back to safe cold-starts when corrupt.

---

## 2. Running Drills & Reading Reports

### 2.1 CLI Execution

Drills are executed via the Node CLI wrapper script [`scripts/incident-drill.mjs`](../scripts/incident-drill.mjs) or through the scanner CLI:

```bash
# Run all 8 incident scenarios
node scripts/incident-drill.mjs

# Run a single scenario by name
node scripts/incident-drill.mjs --scenario rpc-failure

# Output machine-readable JSON report
node scripts/incident-drill.mjs --scenario rpc-failure --json

# Run all scenarios with JSON output
node scripts/incident-drill.mjs --json

# Enable verbose invariant check details
node scripts/incident-drill.mjs --verbose

# Show CLI help and available scenario names
node scripts/incident-drill.mjs --help
```

Available scenario names for `--scenario`:
* `rpc-failure`
* `telegram-failure`
* `stale-cursor`
* `corrupt-cursor`
* `malformed-event`
* `rate-limit`
* `restart`
* `scanner-diagnostic`

---

### 2.2 How to Read the Human-Readable Terminal Report

When run without `--json`, the runner prints human-readable test progress and a summary block:

```text
=======================================================
   Mimir Notifier Incident Drill Simulation
=======================================================
Operating Principles verified:
  * Chain state is the source of truth
  * Notifier is strictly read-only (no signing keys)
  * Bounded cursor movement and safe error redaction
-------------------------------------------------------

[PASS] rpc-failure (106ms)
       - Market target cursor preserved unchanged during RPC failure
       - Status error and console logs bounded and redacted (no secrets or unbounded payloads)
       - Health report correctly flagged degraded target without leaking secrets
       - Poller recovered seamlessly, advanced cursor, and reset consecutive failures

-------------------------------------------------------
Summary: 1 passed, 0 failed in 111ms
=======================================================
```

#### Report Fields Explained:
* **`[PASS]` / `[FAIL]`**: Status tag indicating whether all scenario invariants passed.
* **`Scenario Name`**: The drill scenario executed (e.g. `rpc-failure`).
* **`Duration`**: Elapsed wall-clock time in milliseconds for the scenario.
* **`Details bullet points (- ...)`**: Each explicit operational invariant asserted by the drill.
* **`Error (on failure)`**: Detailed failure message and stack trace if an invariant was violated.
* **`Summary`**: Aggregated count of passed and failed scenarios, along with total runtime.
* **Process Exit Code**: Exits with `0` when all scenarios pass, or `1` if any scenario fails.

---

### 2.3 How to Read the Machine-Readable JSON Report

When `--json` is specified, the CLI outputs structured JSON conforming to the `DrillReport` interface:

```json
{
  "passed": true,
  "totalScenarios": 1,
  "passedScenarios": 1,
  "failedScenarios": 0,
  "totalDurationMs": 99,
  "results": [
    {
      "name": "rpc-failure",
      "passed": true,
      "durationMs": 51,
      "details": [
        "Market target cursor preserved unchanged during RPC failure",
        "Status error and console logs bounded and redacted (no secrets or unbounded payloads)",
        "Health report correctly flagged degraded target without leaking secrets",
        "Poller recovered seamlessly, advanced cursor, and reset consecutive failures"
      ]
    }
  ]
}
```

#### JSON Fields Explained:
* **`passed`** (`boolean`): `true` if all executed scenarios succeeded; `false` if any scenario failed.
* **`totalScenarios`** (`number`): Count of scenarios selected and executed.
* **`passedScenarios`** (`number`): Count of scenarios that passed all invariant checks.
* **`failedScenarios`** (`number`): Count of scenarios that failed.
* **`totalDurationMs`** (`number`): Total execution time across all scenarios in milliseconds.
* **`results`** (`array`): Array of `DrillScenarioResult` objects:
  * **`name`** (`string`): The scenario identifier (`DrillScenarioName`).
  * **`passed`** (`boolean`): Whether this specific scenario passed.
  * **`durationMs`** (`number`): Execution time for this scenario in milliseconds.
  * **`details`** (`string[]`): Invariants verified during execution.
  * **`error`** (`string`, optional): Error explanation if `passed` is `false`.

---

## 3. Incident Drill Scenarios

Each scenario verifies a critical failure mode and asserts specific invariants under simulated adverse conditions.

---

### 3.1 RPC Failure Drill

* **Exported Function:** `runRpcFailureDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `rpc-failure`

#### What is Injected
* An isolated temporary cursor directory initialized with a version-1 cursor file for the `market` and `squad` contracts pointing to ledger 40 (`makeDrillCursor(40)`).
* A fake Soroban RPC server covering ledgers 1 to 100.
* An active RPC failure injected via `rpcController.setFailure(...)` specifically for `marketContractId` requests. The injected error contains a secret bot token (`SECRET_BOT_TOKEN`), a sensitive private key (`SECRET_PRIVATE_KEY`), and an unbounded remote response string (`"unbounded_data_".repeat(50)`).
* In Cycle 1, the poller attempts to scan events for the market contract and encounters the RPC error.
* In Cycle 2, the RPC failure is cleared (`rpcController.clearFailure()`), and a valid `claim_created` event is queued at ledger 50.

#### Expected Behaviour & Invariants Verified
1. **Cursor Immutability During Failure:** The cursor for the failing target (`market`) remains strictly unchanged at ledger 40 (`makeDrillCursor(40)`). The failed scan does not advance, clear, or corrupt the cursor.
2. **Secrets Redaction & Bounded Error Logs:** `status.lastError.message` and `console.error` logs are scrubbed; neither the bot token nor the private key appear. Error strings are bounded to a maximum length (<= 250 characters).
3. **Health Degradation Reporting:** `buildHealthReport(...)` flags the failing market target as degraded (`hasError: true`) while remaining safe and sanitized.
4. **Seamless Self-Healing Recovery:** Once RPC availability is restored in Cycle 2, the poller scans the new event at ledger 50, advances the market cursor to ledger 50, and resets `consecutiveFailures` back to `0`.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"RPC failures"** (symptoms and recovery step: *"The affected contract's cursor is left unchanged after a failed scan, so the next polling cycle can retry from the same position. Do not manually advance the cursor to skip an RPC failure"*).
* Also validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Security and logging"** (redacting tokens, private keys, and unbounded payloads).

#### What a Passing Result Proves
Proves that upstream Soroban RPC outages do not lose the reader's place on the chain, do not leak credentials or oversized payloads into logs or health endpoints, and automatically recover without manual operator intervention once the RPC endpoint is healthy.

---

### 3.2 Telegram Delivery Failure Drill

* **Exported Function:** `runTelegramFailureDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `telegram-failure`

#### What is Injected
* An isolated temporary cursor directory with a valid version-1 cursor at ledger 40.
* A fake Soroban RPC server covering ledgers 1 to 45, with a `claim_challenged` event queued at ledger 45.
* A fake Telegram notifier set to permanent failure mode (`"fail-always"`), rejecting message deliveries with an error containing `SECRET_BOT_TOKEN` (`Telegram HTTP 429 Too Many Requests: ...`).
* In Cycle 1, event scanning succeeds at ledger 45, but delivery to Telegram fails across all bounded retries.
* In Cycle 2, Telegram connectivity recovers (`mode: "ok"`), the chain advances to ledger 46, and a new `claim_created` event is queued at ledger 46.

#### Expected Behaviour & Invariants Verified
1. **Failure Accounting:** The failed send is recorded in `status.notificationsFailed` (incremented to 1).
2. **Lossy Delivery Invariant:** Despite the Telegram failure, the poller's cursor **still advances** past ledger 45. The cursor is not held back. Holding the cursor back would cause an infinite retry loop on revoked tokens or rate limits, blocking all future chain processing.
3. **Secret Masking:** Bot tokens injected into Telegram error objects are masked and never leaked to `console.error` or warning logs during retry attempts.
4. **No Infinite Replay Loop:** On Cycle 2 recovery, only the newly queued event at ledger 46 is notified (`notificationsSent === 1`). The dropped message from ledger 45 is not replayed into the chat.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Telegram failures"** (*"Telegram delivery is intentionally lossy. The poller commits the opaque cursor after processing the returned page, even when sends are partial. A failed send does not hold the cursor back — holding it would turn a revoked token into an infinite replay, and replaying every missed notification could create an unbounded backlog or flood a recovered chat"*).

#### What a Passing Result Proves
Proves that Telegram API outages, rate limits, or chat permission revocations cannot stall the bot, cannot trap it in an infinite retry loop, and do not leak credentials in failure logs.

---

### 3.3 Stale Cursor Drill

* **Exported Function:** `runStaleCursorDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `stale-cursor`

#### What is Injected
* An isolated temporary cursor directory with an initial cursor set to ledger 10 (`makeDrillCursor(10)`).
* A fake Soroban RPC server where the chain has progressed far ahead: oldest retained ledger is 1000 (`oldestLedger: 1000`) and latest ledger is 2000 (`latestLedger: 2000`).
* RPC configured to reject requests using the stale ledger 10 cursor with `"start ledger 10 is before oldest ledger 1000"`.
* In Cycle 1, the poller queries RPC with the stale cursor and receives the out-of-window error.
* In Cycle 2, the poller polls immediately following the automatic rewind.

#### Expected Behaviour & Invariants Verified
1. **Automatic Bounded Floor Rewind:** When a cursor is provably below `oldestLedger`, the poller automatically rewinds the target's reader position to the exact retained floor (`rewindFromLedger === 1000`) and increments `status.cursorRewinds` to 1.
2. **Restart Gap Accounting:** The lost ledger span is recorded as an unreadable gap (`gapLedgers === 990`).
3. **Actionable Status & Health:** An actionable error mentioning `oldest ledger 1000` is exposed in `status.lastError` and reflected in `/health` (`hasError: true`).
4. **Persisted Version-1 Floor Rewind:** The rewind is flushed to the on-disk cursor file with strict version-1 schema compatibility (`targets.market.rewindFromLedger === 1000`), ensuring that a process restart will resume from the floor rather than retrying the expired cursor.
5. **Recovery on Next Cycle:** Cycle 2 successfully queries from ledger 1000, clears `cursorStale`, and resumes normal event polling.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Stale or corrupt cursor"** (*"If the cursor's ledger is strictly below oldestLedger, the position it points at is already unrecoverable, so the poller drops it and rescans from oldestLedger. This is bounded to MAX_FLOOR_REWINDS (3) consecutive automatic rewinds per contract... A floor rewind loses nothing that is still readable — everything below the floor has already left the RPC"*).

#### What a Passing Result Proves
Proves that when the notifier experiences extended downtime exceeding the Soroban RPC retention window, it detects the stale cursor, automatically rewinds to the oldest available ledger without human intervention, records the unreadable gap, persists the recovery state safely, and continues polling.

---

### 3.4 Corrupt Cursor Drill

* **Exported Function:** `runCorruptCursorDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `corrupt-cursor`

#### What is Injected
* An isolated temporary cursor file populated with invalid, unparseable binary garbage (`"CORRUPT_NOT_JSON_BINARY_GARBAGE\x00\x01\x02"`).
* A fake Soroban RPC server covering ledgers 100 to 200.
* Poller configured with `startLookbackLedgers: 20`.

#### Expected Behaviour & Invariants Verified
1. **Safe Cold-Start Fallback Without Crashing:** The poller encounters the unreadable file, catches the parsing error, logs a warning (`"cursor file unreadable, starting cold"`), and continues executing safely (`status.running === true`).
2. **Self-Healing File Repair:** When committing the first poll cycle, the poller heals and overwrites the corrupted file on disk with a valid, clean version-1 JSON cursor structure containing valid target blocks for both `market` and `squad`.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Corrupt cursor file"** and &sect; **"Stale or corrupt cursor"** (*"A corrupt cursor is quarantined beside the live path and treated as a cold start... On a cold start, the poller begins from its configured lookback rather than replaying the entire retained RPC history"*).

#### What a Passing Result Proves
Proves that corrupted or truncated cursor files on disk (caused by abrupt power loss, filesystem corruption, or manual operator edits) do not crash the service, fall back safely to configured lookback scanning, and self-heal the persisted state file.

---

### 3.5 Malformed Event Drill

* **Exported Function:** `runMalformedEventDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `malformed-event`

#### What is Injected
* An isolated temporary cursor directory (cold start).
* A fake Soroban RPC server with two events queued in the same ledger (ledger 50):
  1. A malformed contract event where a topic item contains an unexpected type (`topic: ["claim_challenged", "not-a-valid-number"]`).
  2. A valid `claim_created` event (`claimId: 99`) immediately following the malformed event in the same ledger.

#### Expected Behaviour & Invariants Verified
1. **Safe Event Skipping:** The malformed event is safely decoded as `unknown` with a bounded reason and skipped. It is recorded in `status.eventsSkipped` (incremented to 1) and does not crash the poller.
2. **Subsequent Event Delivery:** The subsequent valid event in ledger 50 is successfully decoded and notified to Telegram (`status.notificationsSent === 1`, message content verified).
3. **Unblocked Cursor Progression:** The target cursor advances past the malformed event to ledger 50 (`lastEventLedger === 50`), ensuring malformed chain events cannot block future events from being processed.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Malformed or unexpected events"** (*"A malformed event must not crash the long-running process. XDR conversion and event metadata failures are converted to a skipped unknown event with a bounded reason. The RPC response cursor is retained, so later events in the page and later pages remain eligible for processing; no cursor rewind or guessed ledger is performed"*).

#### What a Passing Result Proves
Proves that unexpected contract upgrades, non-conforming contract events, or malformed XDR on-chain do not crash the daemon or poison the event queue, allowing valid events to be notified normally.

---

### 3.6 Rate Limit & Burst Drill

* **Exported Function:** `runRateLimitDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `rate-limit`

#### What is Injected
* A poller configuration with `maxNotificationsPerCycle: 10`.
* An initial cursor at ledger 40.
* A fake Soroban RPC server with an event burst of 25 valid `claim_created` events across ledgers 41 through 65 queued for the market contract.

#### Expected Behaviour & Invariants Verified
1. **Strict Notification Capping:** The poller dispatches exactly 10 notifications (`status.notificationsSent === 10`, `notifier.sent.length === 10`), strictly honoring the configured cycle ceiling.
2. **Overflow Accounting:** The remaining 15 events exceeding the ceiling are skipped and tracked in `status.eventsSkipped` (incremented to 15) to prevent Telegram flood-wait errors.
3. **Highest-Ledger Cursor Commitment:** The cursor moves to the highest ledger in the burst (ledger 65, `lastEventLedger === 65`). This prevents the poller from re-reading and re-notifying the burst events on the next cycle.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Rate limiting"** (*"Notification bursts are bounded by MAX_NOTIFICATIONS_PER_CYCLE: each cycle reads one RPC page of that size, commits its page cursor, and then spaces sends out. A restart therefore replays at most one bounded page. If Telegram rate limits are observed... Do not disable the notification cap to compensate. Allow subsequent polling cycles to continue normally"*).

#### What a Passing Result Proves
Proves that high-volume on-chain activity or contract spam cannot overwhelm the Telegram bot or trigger upstream Telegram 429 rate limit bans, while ensuring the cursor advances to avoid replay loops.

---

### 3.7 Process Restart & Operator Pause Drill

* **Exported Function:** `runRestartDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `restart`

#### What is Injected
* An isolated temporary cursor directory with saved cursors for market (ledger 60) and squad (ledger 70).
* A first poller instance (`poller1`) is created and executes one cycle.
* An operator pause is issued (`poller1.pause()`).
* Process restart simulation: `poller1` is stopped (`poller1.stop()`), and a fresh poller instance (`poller2`) is booted pointing to the same cursor file.

#### Expected Behaviour & Invariants Verified
1. **In-Memory Operator Pause:** The operator pause successfully suspends polling on `poller1` (`status.paused === true`).
2. **Strict Cursor File Schema (No Pause Contamination):** The on-disk `cursor.json` file is checked. It remains strictly version 1 and does not persist the `paused` flag.
3. **Automatic Resumption on Restart:** When `poller2` initializes, it starts unpaused (`paused === false`, `running === true`). Pause state is process-local, ensuring that a transient pause does not survive container redeploys or service restarts.
4. **Accurate Cursor Reloading:** The persisted cursor values for both contracts are reloaded into `poller2` without loss or alteration.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Operator pause and resume"** (*"Pause state is process-local. A restart always begins polling while loading the existing version-1 cursor file, preventing a stale pause from surviving a deploy"*) and &sect; **"Process restart"** (drain and cursor reload guarantees).

#### What a Passing Result Proves
Proves that administrative operator pauses cannot corrupt the persistent storage schema, and that restarting or redeploying the bot always resumes active polling from the last saved cursor position.

---

### 3.8 Scanner Diagnostic Drill

* **Exported Function:** `runScannerDiagnosticDrill(): Promise<DrillScenarioResult>`
* **CLI Scenario Name:** `scanner-diagnostic`

#### What is Injected
* A fake Soroban RPC server covering ledgers 100 to 200 configured with empty intermediate pages: `rpcController.setEmptyPagesUntilEvents(2)`.
* An event queued at ledger 150 for the market contract.
* The read-only event scanner (`readContractEvents` from [`src/stellar/events.ts`](../src/stellar/events.ts)) is invoked starting at ledger 100 with `maxPages: 5`.

#### Expected Behaviour & Invariants Verified
1. **Empty Page Traversal:** The scanner traverses through 2 empty intermediate RPC pages before reaching the event page (walks at least 3 pages total), without terminating prematurely.
2. **Accurate Event Decoding:** Exactly 1 event is decoded at ledger 150 (`scan.events.length === 1`, `scan.lastEventLedger === 150`).
3. **Read-Only / Credential-Free Operation:** The scanner executes without requiring a bot token, chat ID, signing key, or writable cursor file.

#### Runbook Step Validated
* Validates [`docs/incident-runbook.md`](incident-runbook.md) &sect; **"Quick health check"** (*"For a read-only chain diagnostic without a Telegram token: npm run scan. Use --from, --pages, or --show when a narrower or deeper scan is needed"*).

#### What a Passing Result Proves
Proves that the operator diagnostics CLI can walk Soroban RPC pagination across empty ledger spans without credentials or state mutation, providing reliable visibility during incident triage.

---

## 4. Orchestration & Programmatic APIs

In addition to individual scenario runners, [`src/drill.ts`](../src/drill.ts) exports high-level orchestrators for integration with test runners and tooling:

### 4.1 `runIncidentDrill(options?: DrillOptions): Promise<DrillReport>`

Orchestrates execution of one or all incident scenarios programmatically:

```typescript
import { runIncidentDrill } from "@mimir-stellar/telegram-bot/drill";

// Run all scenarios
const fullReport = await runIncidentDrill({ scenario: "all" });
console.log(`Passed: ${fullReport.passed} (${fullReport.passedScenarios}/${fullReport.totalScenarios})`);

// Run a single scenario
const singleReport = await runIncidentDrill({ scenario: "rpc-failure" });
```

* **Options (`DrillOptions`):**
  * `scenario`: `"all"` or any specific `DrillScenarioName`. Defaults to `"all"`.
  * `json`: `boolean` — Whether output is intended for JSON serialisation.
  * `verbose`: `boolean` — Whether to log invariant details.
* **Return Value (`DrillReport`):** Aggregates overall pass/fail status, duration, and an array of individual `DrillScenarioResult` items.

### 4.2 `runIncidentDrillCli(): Promise<void>`

The command-line interface driver called by [`scripts/incident-drill.mjs`](../scripts/incident-drill.mjs). It parses command-line arguments (`--scenario`, `--json`, `--verbose`, `--help`), executes `runIncidentDrill`, formats output to `stdout` or `stderr`, and terminates the Node process with exit code `0` (pass) or `1` (failure).

---

## 5. Scenario & Runbook Cross-Reference

| Exported Function | CLI Scenario Name | Primary Injected Condition | Runbook Section Validated | Passing Result Proves |
|---|---|---|---|---|
| [`runRpcFailureDrill`](../src/drill.ts#L354) | `rpc-failure` | Upstream RPC error with sensitive tokens & payloads | [RPC failures](incident-runbook.md#rpc-failures) | Cursor preserved, secrets redacted, self-heals on recovery |
| [`runTelegramFailureDrill`](../src/drill.ts#L476) | `telegram-failure` | Permanent Telegram 429 send failures | [Telegram failures](incident-runbook.md#telegram-failures) | Lossy delivery advances cursor; avoids infinite retry loops |
| [`runStaleCursorDrill`](../src/drill.ts#L590) | `stale-cursor` | Cursor ledger older than RPC retention window | [Stale or corrupt cursor](incident-runbook.md#stale-or-corrupt-cursor) | Automatic floor rewind, gap recorded, resumed from floor |
| [`runCorruptCursorDrill`](../src/drill.ts#L683) | `corrupt-cursor` | Non-JSON binary garbage in cursor file | [Corrupt cursor file](incident-runbook.md#corrupt-cursor-file) | Safe cold-start fallback; repairs version-1 cursor file |
| [`runMalformedEventDrill`](../src/drill.ts#L745) | `malformed-event` | Invalid topic structure in contract event | [Malformed or unexpected events](incident-runbook.md#malformed-or-unexpected-events) | Event safely skipped; subsequent valid events delivered |
| [`runRateLimitDrill`](../src/drill.ts#L821) | `rate-limit` | 25 events in a cycle capped at 10 | [Rate limiting](incident-runbook.md#rate-limiting) | Strict send capping; burst skipped; cursor advances |
| [`runRestartDrill`](../src/drill.ts#L904) | `restart` | Operator pause followed by process reboot | [Operator pause and resume](incident-runbook.md#operator-pause-and-resume) | Pause is process-local; restarts unpaused with cursors intact |
| [`runScannerDiagnosticDrill`](../src/drill.ts#L1003) | `scanner-diagnostic` | Soroban empty pages before event page | [Quick health check](incident-runbook.md#quick-health-check) | Walks empty pages; credential-free read-only inspection |
| [`runIncidentDrill`](../src/drill.ts#L1064) | `all` | Full suite orchestrator | [Verification](incident-runbook.md#incident-drill-simulation) | Validates all 8 scenarios and generates unified report |
| [`runIncidentDrillCli`](../src/drill.ts#L1116) | N/A (CLI entry) | Command line runner and reporter | [Verification](incident-runbook.md#incident-drill-simulation) | Formats terminal or JSON reports; enforces exit codes |
