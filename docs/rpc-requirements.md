# Soroban RPC Requirements

This document outlines the technical requirements for a Soroban RPC endpoint used by the Telegram bot. It is intended to help operators select a compatible provider or self-host their own instance.

---

## 1. Required RPC Methods

The bot is a read-only event listener and does not submit transactions. It interacts with Soroban RPC via `@stellar/stellar-sdk` using the following methods:

| Method | Role in Bot | Usage Context |
| :--- | :--- | :--- |
| `getHealth` | Validates endpoint health, chain tip, and retention boundaries | Called during startup health checks, periodically at each polling cycle, and before event queries (`src/stellar/client.ts`, `src/stellar/events.ts`, `src/poller.ts`) |
| `getEvents` | Reads contract event logs using pagination filters | Sequentially queried by cursor or start ledger in `paginatedGetEvents` (`src/stellar/events.ts`) |
| `getNetwork` | Validates network identity and passphrase alignment | Invoked at startup via `validateNetworkPassphrase` (`src/stellar/client.ts`, `src/index.ts`) to prevent running against the wrong network |

### Method Payloads & Expectations

#### `getHealth`
The bot requires `getHealth` to report the retained ledger window:
```json
{
  "status": "healthy",
  "latestLedger": 1234567,
  "oldestLedger": 1113607
}
```
- `latestLedger`: Must be a positive integer sequence representing current chain tip.
- `oldestLedger`: Must be a positive integer sequence representing the oldest retained ledger.
- `validateLedgerWindow` ensures `oldestLedger <= latestLedger`. If values are missing, non-integer, or inverted (`oldest > latest`), the bot raises a `LedgerWindowError("malformed-window")` and halts or skips the cycle.

#### `getEvents`
Called with JSON-RPC parameters matching Soroban RPC specs:
- **Filters**: Topic/contract filters (e.g. `[{ type: "contract", contractIds: [...] }]`).
- **Paging bounds**: Accepts either `startLedger` or `cursor` (mutually exclusive).
- **Responses**: Returns `events` array along with `latestLedger` and a pagination `cursor`.
- **Note on pagination**: In Soroban RPC, an empty `events` list does not necessarily indicate the end of events—it indicates no events were found in the inspected slice of ledgers. The bot continues walking via `cursor` until the cursor reaches the tip.

#### `getNetwork`
Used at boot to verify the network passphrase (e.g. `Test SDF Network ; September 2015` for Testnet or `Public Global Stellar Network ; September 2015` for Mainnet):
```json
{
  "passphrase": "Test SDF Network ; September 2015",
  "protocolVersion": 22
}
```
If the passphrase does not match configuration, the bot refuses to boot with `NetworkPassphraseMismatchError`.

---

## 2. Retention Window Expectations

Soroban RPC endpoints maintain a rolling retention window of historical ledgers (typically ~120,960 ledgers on public Testnet, equivalent to approximately 7 days at 5 seconds per ledger).

### Retention Window Mechanics
- Queries specifying `startLedger < oldestLedger` will be rejected by the RPC.
- The bot calls `clampStartLedger` to clamp requested start ledgers up to `oldestLedger`.
- Queries specifying `startLedger > latestLedger` or cursors minted beyond `latestLedger` trigger `LedgerWindowError("start-after-tip")` or are flagged before reaching the RPC.

### Relationship Between `START_LOOKBACK_LEDGERS` and Retention

`START_LOOKBACK_LEDGERS` controls how many ledgers behind the chain tip the bot checks when performing a **cold start** (e.g., initial deployment, missing `CURSOR_FILE`, or after recovering from a corrupted cursor file):

$$\text{requestedStartLedger} = \text{latestLedger} - \text{START\_LOOKBACK\_LEDGERS}$$

- **Normal operation (Default `60` ledgers $\approx$ 5 minutes)**: Well within typical RPC retention (~120,960 ledgers).
- **Large lookbacks**: If an operator sets `START_LOOKBACK_LEDGERS` greater than the RPC's retention capacity (e.g., setting lookback to 200,000 ledgers when RPC retention is 120,960), `clampStartLedger` automatically clamps the start ledger to `oldestLedger`.
- **Very small retention windows**: If an RPC endpoint only retains a few dozen ledgers, any temporary network interruption or startup delay can lead to immediate cursor eviction.

---

## 3. Symptoms of an Unsuitable RPC Endpoint

An endpoint with insufficient retention, rate limits, lagging synchronization, or unstable health reports will cause operational issues:

| Symptom | Cause | Bot Manifestation |
| :--- | :--- | :--- |
| **Stale Cursor (`cursor-before-floor`)** | The bot was down or paused longer than the endpoint's retention window, or the endpoint pruned history aggressively. | The RPC rejects queries with an error matching stale cursor patterns. The bot confirms the condition via `getHealth()`, records a `stale_cursor` event in audit logs, and flags `cursorStale = true`. |
| **Restart Gaps (`restartGaps`, `gapLedgers`)** | When a stale cursor is detected and verified against `oldestLedger`, the bot is forced to rewind its cursor to `oldestLedger`. | The bot logs: `[poller] <source>: restart gap - cursor at ledger X is Y ledger(s) below the retained floor; skipping Y missed ledger(s) to resume from Z`. The missing ledgers in that gap are permanently skipped and will not trigger notifications. |
| **Malformed Ledger Window Errors** | The endpoint omits `oldestLedger`/`latestLedger` or reports inverted values (`oldest > latest`). | Poller raises `LedgerWindowError` (`malformed-window`), aborting the cycle. |
| **Inverted or Stalled Ledgers** | The RPC endpoint serves requests from an out-of-sync backend node or a pool of load-balanced nodes with drifting ledger tips. | `latestLedger` oscillates backwards or fails to advance, resulting in duplicate query retries, cursor stalls, or `cursor-after-tip` errors. |
| **Frequent Timeouts / Rate Limits (HTTP 429 / 504)** | Public shared endpoints often enforce strict rate limits or experience high load during peak testnet activity. | Poller enters exponential backoff, health status degrades, and notification latency increases. |

---

## 4. Running a Local `stellar-rpc` for Testnet

To avoid public rate limits and ensure predictable retention windows, operators can run a local `stellar-rpc` node connected to Testnet using Docker and the official Stellar Quickstart container.

### Running with Docker

Run the official Stellar Quickstart image configured for Testnet with RPC enabled:

```bash
docker run --rm -it \
  -p 8000:8000 \
  --name stellar-testnet-rpc \
  stellar/quickstart:latest \
  --testnet \
  --enable-rpc
```

For persistent data storage (retaining history across container restarts), mount a local directory to `/opt/stellar`:

```bash
docker run -d \
  -p 8000:8000 \
  --name stellar-testnet-rpc \
  -v stellar_testnet_data:/opt/stellar \
  stellar/quickstart:latest \
  --testnet \
  --enable-rpc
```

### Verifying Endpoint Readiness

1. **Verify Health & Retention**:
   ```bash
   curl -s -X POST "http://localhost:8000/rpc" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
   Ensure the response includes `"status": "healthy"` and non-null values for `latestLedger` and `oldestLedger`.

2. **Verify Network Passphrase**:
   ```bash
   curl -s -X POST "http://localhost:8000/rpc" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}'
   ```
   Confirm `"passphrase": "Test SDF Network ; September 2015"`.

### Pointing the Bot to Local RPC

Configure your bot's `.env` file or environment variables:

```env
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=http://localhost:8000/rpc
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```
