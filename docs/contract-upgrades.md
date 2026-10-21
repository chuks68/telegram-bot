# Upgrading and Redeploying Mimir Contracts

Operational guide for updating the Mimir Telegram bot when contracts (`mimir-market`, `mimir-squad`) are redeployed or upgraded in-place on Stellar.

---

## 1. Upgrade Scenarios: In-Place Upgrade vs. Redeployment

When smart contracts change on Stellar/Soroban, the bot accommodates two distinct operational scenarios:

| Dimension | In-Place Upgrade (Wasm Upgrade) | Redeployment (Fresh Deployment) |
| :--- | :--- | :--- |
| **Contract ID (`C...`)** | **Unchanged** | **New Contract ID** |
| **Contract Version** | **Incremented / Changed** (e.g., `v1` $\rightarrow$ `v2`) | Typically initial version for new deployment (or updated) |
| **Historical Events** | Continuous; emitted under the same contract ID | Discontinuous; new contract starts at emission ledger `N` |
| **Cursor Position** | Continuous; cursor points to existing ledger sequence | Must be reset or cleared for the new contract |
| **Bot Environment Change** | Update version variables | Update contract ID variables (and reset cursor) |

### 1.1 In-Place Upgrade (Same ID, New Version)
- **What happens:** The contract admin invokes the contract's Wasm upgrade method (or Soroban upgrade mechanism). The contract address (`C...`) remains identical, but contract logic and event schemas may advance.
- **Bot configuration:**
  - `MARKET_CONTRACT_ID` / `SQUAD_CONTRACT_ID` remain **unchanged**.
  - `MARKET_CONTRACT_VERSION` / `SQUAD_CONTRACT_VERSION` are updated to match the new version (e.g. `v2`).
- **Cursor continuity:** The poller retains its existing cursor file (`CURSOR_FILE`, default `./data/cursor.json`) because the contract address has not changed. The event stream continues seamlessly across the upgrade transaction.

### 1.2 Redeployment (New ID)
- **What happens:** A completely new contract instance is deployed to the network with a fresh contract ID (`C...`).
- **Bot configuration:**
  - `MARKET_CONTRACT_ID` and/or `SQUAD_CONTRACT_ID` are set to the new `C...` strkeys.
  - `MARKET_CONTRACT_VERSION` and `SQUAD_CONTRACT_VERSION` are adjusted if the new deployment corresponds to a specific version schema.
- **Cursor handling:** A cursor persisted from the old contract is keyed by target source (`market` / `squad`), but pointing to an arbitrary ledger on the old contract stream. To avoid querying historical ranges or misaligning sequence tokens, the cursor for the redeployed contract must be reset.

---

## 2. Environment Variables Reference

All environment variables match [`src/config.ts`](../src/config.ts):

| Variable | Required | Default | Format / Validation | Description |
| :--- | :--- | :--- | :--- | :--- |
| `MARKET_CONTRACT_ID` | Yes | None | `^C[A-Z2-7]{55}$` (56-char Soroban strkey) | Contract ID for `mimir-market`. |
| `SQUAD_CONTRACT_ID` | Yes | None | `^C[A-Z2-7]{55}$` (56-char Soroban strkey) | Contract ID for `mimir-squad`. |
| `MARKET_CONTRACT_VERSION` | No | `v1` | `^[a-z0-9_.-]+$` (lowercased) | Decoder version for `mimir-market` (e.g. `v1`, `v2`). |
| `SQUAD_CONTRACT_VERSION` | No | `v1` | `^[a-z0-9_.-]+$` (lowercased) | Decoder version for `mimir-squad` (e.g. `v1`, `v2`). |
| `CURSOR_FILE` | No | `./data/cursor.json` | Path | File path for persisting last-seen event cursors. |
| `START_LOOKBACK_LEDGERS` | No | `60` | Positive integer $\ge 0$ | Ledgers to scan behind the chain tip on cold start. |
| `STELLAR_RPC_URL` | No | Testnet RPC URL | Valid HTTP(S) URL | Soroban RPC endpoint used for polling events. |
| `STELLAR_NETWORK` | No | `testnet` | `testnet` \| `mainnet` \| `futurenet` \| `custom` | Active network identifier. |

---

## 3. Cursor Handling & Operational Procedures

Cursors are managed in `CURSOR_FILE` (default `./data/cursor.json`). The schema stores cursors per target source (`market` and `squad`):

```json
{
  "version": 1,
  "updatedAt": "2026-10-19T07:00:00.000Z",
  "targets": {
    "market": {
      "cursor": "0123456789-0000000001",
      "lastEventLedger": 123456
    },
    "squad": {
      "cursor": "0123456789-0000000002",
      "lastEventLedger": 123456
    }
  }
}
```

### 3.1 Procedure: In-Place Upgrade (Same ID, New Version)
1. **Stop the bot** (or pause polling via `/pause` if authorized).
2. **Update the version variable** in `.env`:
   ```bash
   MARKET_CONTRACT_VERSION=v2
   # or
   SQUAD_CONTRACT_VERSION=v2
   ```
3. **Keep the cursor intact:** Do **not** delete `CURSOR_FILE`. The cursor continues sequentially from the last processed ledger before the upgrade, ensuring zero missed events during the upgrade transaction.
4. **Verify with scanner:** Run `npm run scan` (see [Section 4](#4-verifying-with-npm-run-scan)) to test event retrieval and decoding.
5. **Restart the bot:** Start the service. Verify `/status` or `/health` shows healthy polling.

### 3.2 Procedure: Redeployment (New ID)
When a contract is redeployed with a new ID:
1. **Stop the bot.**
2. **Update contract settings** in `.env`:
   ```bash
   MARKET_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
   MARKET_CONTRACT_VERSION=v1
   ```
3. **Reset the cursor:**
   Because cursors in `CURSOR_FILE` are tied to contract stream positions, an existing cursor from the old contract is invalid for the new contract. Choose one of two options:
   - **Option A (Full Cold Start - Recommended):** Delete or rename `CURSOR_FILE`:
     ```bash
     mv ./data/cursor.json ./data/cursor.json.archive
     ```
     On startup, the bot detects no cursor file and performs a cold start, scanning from `latestLedger - START_LOOKBACK_LEDGERS` (default 60 ledgers $\approx$ 5 minutes behind tip).
   - **Option B (Targeted Reset):** If only one contract was redeployed (e.g. `market` changed but `squad` did not), edit `./data/cursor.json` to nullify the target:
     ```json
     "market": {
       "cursor": null,
       "lastEventLedger": null
     }
     ```
     The poller will cold-start `market` while preserving `squad`'s position.
4. **Tune Cold-Start Lookback (Optional):**
   If the new contract was deployed more than 60 ledgers ago, configure:
   ```bash
   START_LOOKBACK_LEDGERS=300
   ```
   Or leave it at default if you only want to follow events from the deployment tip onward.
5. **Verify with scanner:** Run `npm run scan` to inspect decoded events.
6. **Start the bot:** Monitor boot logs to ensure `[boot] config` reports the new contract address and version.

---

## 4. Verifying with `npm run scan`

Before restarting or resuming production polling, use the read-only standalone scanner `npm run scan` (`src/stellar/events.ts`). It loads `src/config.ts` without requiring Telegram credentials (`BOT_TOKEN` or `TELEGRAM_CHAT_ID`), making it safe for operator verification.

### 4.1 Running the Scan
```bash
# Scan both contracts from oldest retained ledger (or specified lookback)
npm run scan

# Scan only the market contract
npm run scan -- --contract market

# Scan only the squad contract
npm run scan -- --contract squad

# Scan starting from a specific ledger sequence (e.g. deployment ledger)
npm run scan -- --contract market --from 123400

# Scan with structured JSON output for automated validation
npm run scan -- --json --show 5
```

### 4.2 What to Inspect in Scan Output
Check the scanner report:
```text
RPC        https://soroban-testnet.stellar.org (testnet)
ledgers    oldest=120000 latest=123500

=== market  CAAA... ===
pages=1 emptyPages=0 events=3 duplicates=0 truncated=false lastEventLedger=123490 cursor=...
    1  claim_created
    2  claim_challenged
```

Verify that:
1. **Contract ID is matched:** The header shows the expected `C...` address.
2. **Events are decoded:** The event histogram lists known event names (`claim_created`, `claim_resolved`, `market_created`, etc.).
3. **No unexpected `unknown` events:** Check that new event types are recognized and not falling back to `unknown` payloads.

---

## 5. Rollback Procedures

If an upgrade or redeployment exhibits issues, roll back using the steps below. Because the bot is strictly **read-only**, rolling back touches only local configuration and cursor files; no on-chain state is modified.

### 5.1 Rolling Back an In-Place Upgrade
1. Stop the bot.
2. Revert the version variable in `.env`:
   ```bash
   MARKET_CONTRACT_VERSION=v1
   ```
3. If the contract on-chain was rolled back or if invalid events caused cursor confusion:
   - Check if `./data/cursor.json.bak` exists and predates the upgrade; you can restore it:
     ```bash
     cp ./data/cursor.json.bak ./data/cursor.json
     ```
   - Alternatively, nullify `cursor` in `CURSOR_FILE` or remove `CURSOR_FILE` for a clean lookback restart.
4. Run `npm run scan` to verify v1 decoding.
5. Restart the bot.

### 5.2 Rolling Back a Redeployment
1. Stop the bot.
2. Revert the contract IDs in `.env` to the previous contract addresses:
   ```bash
   MARKET_CONTRACT_ID=<PREVIOUS_MARKET_CONTRACT_ID>
   ```
3. If returning to the old contract, restore the archived cursor file (if preserved during the redeploy):
   ```bash
   mv ./data/cursor.json.archive ./data/cursor.json
   ```
   If no backup exists, remove `CURSOR_FILE` so the poller performs a safe cold start lookback.
4. Verify with `npm run scan`.
5. Restart the bot.

---

## 6. Signals that a Decoder Update is Needed

In `src/stellar/decode.ts`, any event that fails topic counts, scalar parsing, or topic layout matching is safely wrapped in an `UnknownPayload` rather than throwing an exception:

```ts
export interface UnknownPayload {
  name: "unknown";
  eventName: string;
  reason?: string;
}
```

The poller skips sending notifications for `unknown` events and increments internal counters (`status.eventsSkipped`).

### 6.1 Observability Indicators
Monitor the following signals to detect that contract events have diverged from the bot's decoders:

1. **Rising `eventsSkipped` Counter:**
   - In `/status` or `GET /health`, check `eventsSkipped`. If this count climbs after a contract upgrade or migration while `notificationsSent` plateaus, the bot is receiving unrecognized events.
2. **Poller Logs:**
   - The poller logs skipped unknown events:
     ```text
     [poller] skipped unknown event "claim_v2_disputed" (unrecognized event name)
     ```
   - Search logs for `unknown` or `action="event_skipped"`.
3. **Scan Histogram Diagnostics:**
   - Running `npm run scan` displays an event histogram. Look for entries named `unknown`:
     ```text
     pages=2 emptyPages=0 events=15 duplicates=0 ...
        10  claim_created
         5  unknown
     ```
   - Inspect the detailed log snippet to see the unrecognized event name and reason:
     ```text
     unknown "claim_created" (claim_created.category: expected string, got undefined)
     ```
4. **Audit Trail Entries (`AUDIT_FILE`):**
   - Check `./data/audit.jsonl` using `npm run audit`. Events that fail decoding are recorded with their unparsed names.

### 6.2 Action Items when Unknown Events Rise
When unknown events increase:
1. Verify whether `MARKET_CONTRACT_VERSION` or `SQUAD_CONTRACT_VERSION` was updated in `.env` to match the newly deployed contract version (e.g. `v2`).
2. If the contract version was already updated, refer to [Decoder Authoring Guide](decoder-authoring.md) to implement or adjust decoders for new event schemas or field extensions.
