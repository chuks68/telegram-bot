# Five-Minute Quickstart: Local Mock RPC & Dry-Run Notifier

This guide walks new contributors through running the Mimir Telegram notifier
locally in **under five minutes** without registering a Telegram bot, obtaining
API tokens, or connecting to live Stellar Testnet.

Every command works on a fresh checkout without creating a `.env` file.

---

## Overview

The repository provides a self-contained local mock profile (`MIMIR_PROFILE=mock`):
- **Mock Soroban RPC** (`npm run mock:rpc`): serves deterministic contract events on `http://127.0.0.1:8420`.
- **Mock Scanner** (`npm run scan:mock`): walks through event pages and decodes contract events on loopback.
- **Mock Poller** (`npm run mock:poll`): boots the in-process mock RPC, starts the real poller, and logs formatted Telegram notifications to stdout instead of calling external APIs.

---

## Numbered Steps

### Step 1: Install dependencies

Install the project dependencies pinned in `package-lock.json`:

```bash
npm ci
```

*(Alternatively, run `npm install` on a fresh development machine.)*

### Step 2: Build the project

Compile the TypeScript source code (`src/` → `dist/`):

```bash
npm run build
```

Expected output snippet:

```text
> @mimir-stellar/telegram-bot@0.1.0 build
> tsc -p tsconfig.json
```

### Step 3: Start the local mock RPC server

Start the mock Soroban RPC server on loopback (`http://127.0.0.1:8420`):

```bash
npm run mock:rpc
```

Expected output snippet:

```text
> @mimir-stellar/telegram-bot@0.1.0 mock:rpc
> tsx src/stellar/mock-rpc.ts

[mock-rpc] listening on http://127.0.0.1:8420 · ledgers 900..1000 · events 10 · 50 ledger(s) per page
[mock-rpc] ready — point a client at it with: npm run scan -- --mock
[mock-rpc] press Ctrl+C to stop
```

Leave this process running in your terminal. It serves sample events across
ledgers 900 to 1000 for both `mimir-market` and `mimir-squad` contracts.

### Step 4: Scan events from the mock RPC

Open a **second terminal** in the repository root and scan the mock RPC:

```bash
npm run scan:mock
```

Expected output snippet:

```text
> @mimir-stellar/telegram-bot@0.1.0 scan:mock
> tsx src/stellar/events.ts --mock

RPC        http://127.0.0.1:8420 (mock)
ledgers    oldest=900 latest=1000
rpc requests=1 failures=0 total=... health=1 events=0

=== market  CAP3GIE7KQDU4NOEF2UPNP7YRH2ARA6KBXXFV73RNBVEGMRCIKT4BBNF ===
pages=3 emptyPages=2 events=6 duplicates=0 truncated=false lastEventLedger=998 cursor=... start=900
  rpc requests=4 failures=0 ...
     1  challenger_paid
     1  claim_challenged
     1  claim_created
     1  claim_resolved
     1  market_settled
     1  oracle_changed

  ledger 996  tx 12a3592cbff154c07dbea38e8b9b3cf909eb9a76014df65e9fed837767c5161f
  claim #7 resolved winner_side=2 confidence=100
  {"name":"claim_resolved","claimId":7,"winnerSide":2,"summary":"On-chain smoke: challengers awarded so the payout pull can be exercised","confidence":100,"evidenceHash":"..."}

  ledger 997  tx 460abd5ed71c973e1dee626de466a6d0a5c23695bf17266efca7bdfbb184e5b6
  claim #7 settled paid=1.8000000 USDC fees=0.1000000 USDC
  {"name":"market_settled","claimId":7,"totalPaid":"18000000","totalFees":"1000000","owedToChallengers":"17000000","dust":"0"}

=== squad  CADTGYRIPLZRIZBQVYT7ZD6K5LG5CSLLEX53WIG5NXJLTUSEYN7ATYAQ ===
pages=3 emptyPages=1 events=4 duplicates=0 truncated=false lastEventLedger=1000 cursor=... start=900
  ...
```

The scanner connects to the loopback mock RPC, walks through event pages, decodes
contract events, and logs the parsed payloads.

Once verified, you can press `Ctrl+C` in the first terminal to stop `mock:rpc`.

### Step 5: Run the mock poller (rendered notification dry run)

Run the full notifier pipeline in dry-run mode:

```bash
npm run mock:poll
```

This command automatically starts an in-process mock RPC, spins up the real
poller, launches the health endpoint on `http://127.0.0.1:8787`, and logs rendered
Telegram notification messages to the console instead of transmitting them to
Telegram.

Expected output snippet:

```text
> @mimir-stellar/telegram-bot@0.1.0 mock:poll
> tsx src/mock-run.ts

[mock-rpc] listening on http://127.0.0.1:8420 · ledgers 900..1000 · events 10 · 50 ledger(s) per page
[dry-run] Mimir notifier dry run — Telegram sends are logged, not delivered
[dry-run] profile   mock
[dry-run] network   mock · rpc http://127.0.0.1:8420
[dry-run] market    CAP3GIE7KQDU4NOEF2UPNP7YRH2ARA6KBXXFV73RNBVEGMRCIKT4BBNF
[dry-run] squad     CADTGYRIPLZRIZBQVYT7ZD6K5LG5CSLLEX53WIG5NXJLTUSEYN7ATYAQ
[dry-run] cursor    .../data/cursor.mock.json
[dry-run] poll      every 30000ms · cap 20 notification(s)/cycle
[dry-run] config    profile=mock env-file=absent process-env=1 profile-default=8 built-in-default=16 derived=2 unset=3 secret-keys=6/30
[health] listening on http://127.0.0.1:8787 (GET /health, GET /health/live)
[dry-run] health    http://127.0.0.1:8787 (GET /health, GET /health/live)
[poller] instance lock acquired pid=... file=.../data/poller.lock
[poller] no cursor file at .../data/cursor.mock.json; cold start 60 ledgers behind the tip
[poller] watching market=CAP3GIE7KQDU4NOEF2UPNP7YRH2ARA6KBXXFV73RNBVEGMRCIKT4BBNF (v1) squad=CADTGYRIPLZRIZBQVYT7ZD6K5LG5CSLLEX53WIG5NXJLTUSEYN7ATYAQ (v1) every 30000ms
[dry-run] would send 186 chars: 🆕 *New claim* \#7 Category: crypto Creator: `GCLJO…HFA5` _ledger 990_ · [tx](https://stellar.expert/explorer/testnet/tx/2b386012af5ccc719db70a47b2f8cc486099de…
[dry-run] would send 204 chars: ⚔️ *Claim \#7 challenged* Stake: *2\.0000000 USDC* Challenger: `GC22M…VNTV` _ledger 992_ · [tx](https://stellar.expert/explorer/testnet/tx/85a6dfee240a97af625f…
```

While `mock:poll` is running, you can probe its health check endpoint from another terminal:

```bash
curl -s http://127.0.0.1:8787/health
```

Press `Ctrl+C` to stop `mock:poll` when finished.

---

## Simulating Failure Drills

`mock:poll` supports rehearsing edge cases and failure modes without touching production or network services:

```bash
# Simulate persistent RPC event errors
npm run mock:poll -- --fail-events error

# Simulate stale cursor rejection
npm run mock:poll -- --stale-cursor

# Inject an undecodable/malformed event to ensure graceful skipping
npm run mock:poll -- --malformed
```

All drills use `data/cursor.mock.json`, keeping drill cursors isolated from any
live state.

For detailed failure drill information and the full fixture catalog, refer to
[docs/contributor-fixtures.md](contributor-fixtures.md).
