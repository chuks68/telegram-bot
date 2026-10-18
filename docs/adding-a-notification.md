# Adding a Notification Type

This guide shows contributors every file and function required to support a new Soroban contract event in `@mimir/telegram-bot`.

It walks through an end-to-end worked example for a hypothetical `claim_escalated` event emitted by the `mimir-market` contract, includes a contributor checklist covering types, decoder, localization strings, formatters, filters, fixtures, tests, and documentation, and explains how to verify your changes locally with `npm run mock:poll`.

---

## Notification Pipeline Overview

When the poller runs (`src/poller.ts`), each contract event flows through five stages before reaching Telegram (`src/bot.ts`):

```text
Soroban RPC getEvents (src/stellar/events.ts)
  │
  ▼
1. decodeEvent(source, rawEvent, version) (src/stellar/decode.ts)
   - Enforces XDR size caps (assertEventXdrWithinCap)
   - Validates #[topic] layout (validateTopicSchema against MARKET_TOPIC_SCHEMAS / SQUAD_TOPIC_SCHEMAS)
   - Dispatches to decodeMarketV1 / decodeMarketV2 / decodeSquadV1 / decodeSquadV2 / decodeAdmin
   - Returns DecodedEvent (or UnknownPayload on unrecognized/malformed events; never throws)
  │
  ▼
2. Feature Flag & Admin Routing (src/poller.ts & src/notifications/featureFlags.ts)
   - Admin payloads (isAdminPayload) are routed to toAdminAuditRecord and skipped for public broadcast
   - Public notifications check isNotificationAllowed(config.featureFlags, event.source, event.payload.name)
  │
  ▼
3. Category Filter & Formatting (src/notifications/format.ts & src/i18n.ts)
   - formatEvent(config, event) checks eventAllowedByCategory(config, event)
   - Renders MarkdownV2 via headline(event) -> NOTIFICATION_MD.<template>(...) + footer(config, event)
   - Attaches inline explorer button via explorerKeyboard(config, event) when txHash is valid
   - If formatting throws, degrades to formatFallbackEvent(config, event, reason)
  │
  ▼
4. Telegram Broadcast & Plain-Text Fallback (src/bot.ts & src/notifications/format.ts)
   - Sends MarkdownV2 message to configured channels
   - On Telegram "can't parse entities" error (isMarkdownParseError), falls back to
     formatPlainTextEvent(config, event) -> plainHeadline(event) -> NOTIFICATION_PLAIN.<template>(...)
```

---

## Worked Example: Adding `claim_escalated`

Suppose the `mimir-market` contract adds a new `ClaimEscalated` event emitted when a disputed claim is escalated to a secondary arbitration round:

```rust
#[contractevent]
pub struct ClaimEscalated {
    #[topic]
    pub claim_id: u64,
    #[topic]
    pub escalator: Address,
    pub bond: i128,
    pub reason: String,
}
```

Per Soroban's `#[contractevent]` wire layout:
- `topic[0]` is the snake_case symbol `"claim_escalated"`.
- `topic[1]` is `claim_id` (`u64` — decoded as a safe non-negative integer via `num`).
- `topic[2]` is `escalator` (`Address` — decoded as a 56-character Stellar strkey via `addr`).
- `value` is an `scvMap` containing `{ bond: i128, reason: String }`.

Below is every file you need to touch to wire `claim_escalated` into the bot.

---

### Step 1: Add the Payload Type (`src/stellar/decode.ts`)

1. **Extend `MarketPayload` (or `SquadPayload` / `AdminPayload`)** in `src/stellar/decode.ts`:

   For a `mimir-market` event, add a new variant to the `MarketPayload` union type:

   ```ts
   export type MarketPayload =
     | {
         name: "claim_created";
         claimId: number;
         creator: string;
         category: string;
         stake: bigint;
         challengeWindowEnd: number;
         resolutionDeadline: number;
       }
     // ... existing variants ...
     | {
         name: "claim_escalated";
         claimId: number;
         escalator: string;
         bond: bigint;
         reason: string;
       };
   ```

   *(If you are adding a `mimir-squad` event instead, declare a `export type SquadEscalatedPayload = { name: "..."; ... }` alias and add it to the `SquadPayload` union. If you are adding a non-notifying administrative event, declare its payload type, add it to `AdminPayload`, and update `isAdminPayload` and `toAdminAuditRecord`.)*

2. **Add a typed event alias and update `MarketEvent`** in `src/stellar/decode.ts`:

   ```ts
   export type ClaimEscalatedEvent = EventMeta & {
     payload: Extract<MarketPayload, { name: "claim_escalated" }>;
   };

   export type MarketEvent =
     | ClaimCreatedEvent
     | ClaimChallengedEvent
     | ClaimResolvedEvent
     | MarketSettledEvent
     | ChallengerPaidEvent
     | ClaimCancelledEvent
     | FeeClaimedEvent
     | WithdrawalQueuedEvent
     | WithdrawalEvent
     | ClaimEscalatedEvent;
   ```

---

### Step 2: Register the Topic Schema and Decoder (`src/stellar/decode.ts`)

1. **Register the topic schema in `MARKET_TOPIC_SCHEMAS` (or `SQUAD_TOPIC_SCHEMAS`)**:

   `validateTopicSchema(source, eventName, topics)` runs before versioned decoding to verify the number and kinds (`"int"` or `"address"`) of `#[topic]` arguments after `topic[0]`:

   ```ts
   export const MARKET_TOPIC_SCHEMAS: Record<string, TopicSchema> = {
     claim_created: { expectedCount: 2, args: ["int", "address"] },
     // ... existing schemas ...
     claim_escalated: { expectedCount: 2, args: ["int", "address"] },
   };
   ```

   - `expectedCount` is the number of indexed topic arguments **excluding** `topic[0]` (the event name symbol).
   - Each entry in `args` is `"int"` (numeric `u32`/`u64`/`i64`/`u128`/`i128`) or `"address"` (Stellar `G...` or `C...` strkey).

2. **Decode the event in `decodeMarketV1` (and `decodeMarketV2`, or `decodeSquadV1` / `decodeSquadV2`)**:

   In `src/stellar/decode.ts`, add a `case` branch to `decodeMarketV1(name, topics, fields)` using the scalar validation helpers:

   ```ts
   case "claim_escalated":
     return {
       name,
       claimId: num(topicAt(topics, 1, "claim_id"), "claim_id"),
       escalator: addr(topicAt(topics, 2, "escalator"), "escalator"),
       bond: amount(fields.bond, "bond"),
       reason: str(fields.reason, "reason"),
     };
   ```

   **Available scalar helpers in `src/stellar/decode.ts`:**
   | Helper | Return Type | Purpose |
   | --- | --- | --- |
   | `topicAt(topics, index, what)` | `unknown` | Reads `topics[index]` (`1`-indexed for payload topics) or throws `DecodeError`. |
   | `num(value, what)` | `number` | Non-negative safe integer (`<= Number.MAX_SAFE_INTEGER`) for IDs, timestamps, bps, and enum discriminants. |
   | `amount(value, what)` | `bigint` | Non-negative `bigint` for atomic USDC amounts (7 decimals, `USDC_UNIT = 10_000_000n`). |
   | `big(value, what)` | `bigint` | Signed or unsigned `bigint`. |
   | `str(value, what)` | `string` | UTF-8 string capped at `MAX_DECODED_STRING_CHARS` (2,048 chars). |
   | `optStr(value, what)` | `string \| undefined` | Optional UTF-8 string (`undefined` for `null`/`undefined`/empty). |
   | `addr(value, what)` | `string` | Valid 56-char Stellar `G...` or `C...` strkey address. |
   | `optAddr(value, what)` | `string \| undefined` | Optional Stellar strkey address. |
   | `hex(value, what)` | `string` | Hex string from a `Uint8Array` or `string`. |

   > **Note on contract schema versions (`v1` vs `v2`):** `decodeMarketV2` delegates to `decodeMarketV1` by default (`MARKET_DECODERS = { v1: decodeMarketV1, v2: decodeMarketV2 }`). If the new event only exists in `v2` or changes wire layout in `v2`, place the `v2`-specific logic in `decodeMarketV2` (or `decodeSquadV2` for `SQUAD_DECODERS`).

---

### Step 3: Add Localization Strings (`src/i18n.ts`)

Every user-facing notification requires **two** templates in `src/i18n.ts`:
1. `NOTIFICATION_MD` — Telegram MarkdownV2 template.
2. `NOTIFICATION_PLAIN` — Plain-text fallback template (used when Telegram rejects MarkdownV2 entities).

1. **Add the MarkdownV2 template to `NOTIFICATION_MD` in `src/i18n.ts`**:

   Dynamic values passed into `NOTIFICATION_MD` functions are already escaped with `escapeMd` by `src/notifications/format.ts`, so **do not** escape parameters inside `src/i18n.ts`. However, any **static** characters in the template literal that belong to Telegram's MarkdownV2 reserved set (`_*[]()~`>#+-=|{}.!\`) **must** be escaped with `\\` unless they are intentional formatting delimiters (such as `*bold*` or `` `code` ``):

   ```ts
   export const NOTIFICATION_MD = {
     // ... existing templates ...
     claimEscalated: (claimId: number, escalator: string, bond: string, reason: string) =>
       `🚨 *Claim \\#${claimId} escalated* by ${escalator}\n` +
       `Bond: *${bond}* · Reason: _${reason}_`,
   } as const;
   ```

2. **Add the matching plain-text template to `NOTIFICATION_PLAIN` in `src/i18n.ts`**:

   `NOTIFICATION_PLAIN` must convey the same information as `NOTIFICATION_MD` without any Markdown formatting symbols (`*`, `_`, `` ` ``, `[...]`) or backslash escapes:

   ```ts
   export const NOTIFICATION_PLAIN = {
     // ... existing templates ...
     claimEscalated: (claimId: number, escalator: string, bond: string, reason: string) =>
       `Claim #${claimId} escalated by ${escalator}\n` +
       `Bond: ${bond} · Reason: ${reason}`,
   } as const;
   ```

---

### Step 4: Format the Event (`src/notifications/format.ts` & `src/notifications/digest-grouping.ts`)

Open `src/notifications/format.ts` and wire the new payload into both `headline` (MarkdownV2) and `plainHeadline` (plain text).

1. **Add a branch to `headline(event: DecodedEvent): string | null`**:

   Use the formatting helpers in `src/notifications/format.ts`:
   - `who(address)` — shortens the address via `shortAddress` and wraps it in MarkdownV2 inline code (`` `GABC…WXYZ` ``).
   - `usdc(units)` — formats atomic USDC via `formatUsdc(units)` and escapes it with `escapeMd`.
   - `escapeMd(clip(text))` — truncates untrusted contract strings to `MAX_EVENT_FIELD_LENGTH` (200 code points) without splitting surrogate pairs, then escapes all 18 MarkdownV2 special characters.

   ```ts
   function headline(event: DecodedEvent): string | null {
     const p = event.payload;
     switch (p.name) {
       // ... existing cases ...
       case "claim_escalated": {
         const reason = escapeMd(clip(p.reason || "unspecified"));
         return NOTIFICATION_MD.claimEscalated(
           p.claimId,
           who(p.escalator),
           usdc(p.bond),
           reason
         );
       }
     }
   }
   ```

2. **Add a matching branch to `plainHeadline(event: DecodedEvent): string | null`**:

   Use `plainWho(address)`, `plainUsdc(units)`, and `clip(text)` (do **not** call `escapeMd` in `plainHeadline`):

   ```ts
   function plainHeadline(event: DecodedEvent): string | null {
     const p = event.payload;
     switch (p.name) {
       // ... existing cases ...
       case "claim_escalated": {
         const reason = clip(p.reason || "unspecified");
         return NOTIFICATION_PLAIN.claimEscalated(
           p.claimId,
           plainWho(p.escalator),
           plainUsdc(p.bond),
           reason
         );
       }
     }
   }
   ```

   `formatEvent(config, event)`, `formatPlainTextEvent(config, event)`, `formatLastEvent(config, event)`, and `formatDigest(events, options)` all delegate to `headline` and `plainHeadline`, so updating those two functions automatically enables single-event notifications, `/last` previews, plain-text fallback, and digest summaries.

3. **Check digest grouping (`src/notifications/digest-grouping.ts`)**:

   `groupDigestEvents(events)` groups market events that have a numeric `claimId` property under `market:<claimId>` and squad events that have a numeric `marketId` property under `squad:<marketId>`. Because `claim_escalated` includes `claimId: number` on its payload, `groupDigestEvents` groups it automatically. If your new event uses a different identifier, update `groupKeyForEvent` in `src/notifications/digest-grouping.ts`.

---

### Step 5: Filters and Feature Flags (`src/notifications/format.ts` & `src/notifications/featureFlags.ts`)

1. **Category Filtering (`eventAllowedByCategory` in `src/notifications/format.ts`)**:

   Operators can set `NOTIFY_CATEGORIES` (parsed into `config.notificationCategories`) to filter notifications by category. In `src/notifications/format.ts`, `eventAllowedByCategory(config, event)` checks whether an event is allowed:

   ```ts
   export function eventAllowedByCategory(config: AppConfig, event: DecodedEvent): boolean {
     const filter = config.notificationCategories;
     if (!filter || filter.size === 0) return true;
     if (event.payload.name !== "claim_created") return true;
     const normalized = event.payload.category.trim().toLowerCase();
     if (!normalized) return false;
     return filter.has(normalized);
   }
   ```

   - If your new event does **not** carry a category field (like `claim_escalated`), it passes through `eventAllowedByCategory` unchanged.
   - If your new event carries a `category` field that should be subject to `NOTIFY_CATEGORIES`, update `eventAllowedByCategory` in `src/notifications/format.ts` to inspect `event.payload.category`.

2. **Feature Flags (`src/notifications/featureFlags.ts`)**:

   Runtime notification feature flags are managed in `src/notifications/featureFlags.ts`:
   - `NotificationFeatureFlags` (`enabled`, `market`, `squad`)
   - `DEFAULT_FEATURE_FLAGS`
   - `parseNotificationFeatureFlags(env)` (reads `NOTIFY_ENABLED`, `NOTIFY_MARKET`, `NOTIFY_SQUAD`)
   - `isNotificationAllowed(flagsOrUndefined, source, _eventName?)`
   - `formatFeatureFlags(flagsOrUndefined)`

   By default, `isNotificationAllowed` gates events by their `ContractSource` (`"market"` or `"squad"`), and `src/poller.ts` calls `isNotificationAllowed(config.featureFlags, event.source, event.payload.name)`.
   - If the new event only needs standard contract-level gating (`NOTIFY_MARKET` or `NOTIFY_SQUAD`), no changes to `src/notifications/featureFlags.ts` are required.
   - If the new event requires its own dedicated feature flag (for example, `NOTIFY_ESCALATIONS`), add the boolean field to `NotificationFeatureFlags` and `DEFAULT_FEATURE_FLAGS`, parse the environment variable in `parseNotificationFeatureFlags`, check the event name via the third parameter of `isNotificationAllowed(flagsOrUndefined, source, eventName)`, and include the flag in `formatFeatureFlags`.

---

### Step 6: Update Fixtures and Golden Corpus (`tests/fixtures/` & `scripts/gen-golden-corpus.mjs`)

1. **Synthetic XDR Builders (`tests/fixtures/events.mjs`)**:

   Add a reusable XDR event fixture builder in `tests/fixtures/events.mjs` using the XDR helpers (`sym`, `str`, `u32`, `u64`, `i128`, `addrVal`, `bytesVal`, `scMap`, `baseMeta`):

   ```js
   export function makeClaimEscalatedEvent(overrides = {}) {
     const claimId = overrides.claimId ?? 42;
     const escalator = overrides.escalator ?? SAMPLE_CHALLENGER;
     const bond = overrides.bond ?? 50_000_000n;
     const reason = overrides.reason ?? "Conflicting primary source";
     return {
       ...baseMeta(overrides),
       topic: [sym("claim_escalated"), u64(claimId), addrVal(escalator)],
       value: scMap({
         bond: i128(bond),
         reason: str(reason),
       }),
     };
   }
   ```

2. **Fixture Catalog (`tests/fixtures/events.json` & `tests/fixtures.test.mjs`)**:

   - If you are adding the event to the shared JSON fixture catalog (`tests/fixtures/events.json`), add positive, negative, and boundary entries.
   - If your payload introduces a new `bigint` field name (such as `"bond"`) that is not already in `MONEY_KEYS`, add `"bond"` to `MONEY_KEYS` in both `tests/fixtures.test.mjs` and `tests/golden-corpus.test.mjs` so decimal strings in JSON fixtures hydrate to `BigInt` before formatting.
   - See `docs/contributor-fixtures.md` for full details on the `tests/fixtures/events.json` schema.

3. **Golden Corpus (`scripts/gen-golden-corpus.mjs` & `tests/fixtures/golden/`)**:

   If adding golden snapshot cases in `scripts/gen-golden-corpus.mjs`:
   - Add the new cases to the `CASES` array in `scripts/gen-golden-corpus.mjs`.
   - Regenerate the golden files:
     ```bash
     npm run build && node scripts/gen-golden-corpus.mjs --update
     ```
   - Update `EMOJI_BY_EVENT` and the expected event list in `tests/golden-corpus.test.mjs`.

---

### Step 7: Add Automated Tests (`tests/*.test.mjs`)

When implementing a real event in code, add coverage across the test suite:

- **`tests/decode.test.mjs` & `tests/decode-fixtures.test.mjs`**:
  - Verify `decodeEvent("market", makeClaimEscalatedEvent(), "v1")` returns the expected `ClaimEscalatedEvent` payload.
  - Verify missing fields, wrong scalar types, negative amounts, or invalid addresses degrade safely to `{ name: "unknown" }`.
- **`tests/schema-validation.test.mjs`**:
  - Verify `validateTopicSchema("market", "claim_escalated", ...)` accepts `[sym("claim_escalated"), u64(1), addrVal(ADDR)]` and rejects wrong topic counts or swapped topic kinds.
- **`tests/i18n.test.mjs` & `tests/markdown-lint.test.mjs`**:
  - Verify `NOTIFICATION_MD.claimEscalated(...)` passes `assertValidMarkdownV2` (`lintMarkdownV2`) and `NOTIFICATION_PLAIN.claimEscalated(...)` contains no unescaped Markdown characters or backslashes.
- **`tests/format.test.mjs` & `tests/plaintext-fallback.test.mjs`**:
  - Verify `formatEvent(config, event)` produces valid MarkdownV2, escapes hostile characters in `reason`, truncates long strings via `clip`, and attaches the explorer inline keyboard.
  - Verify `formatPlainTextEvent(config, event)` produces clean plain text and is used when Telegram returns `400: Bad Request: can't parse entities`.
- **`tests/featureFlags.test.mjs`**:
  - If you added a new feature flag in `src/notifications/featureFlags.ts`, test `parseNotificationFeatureFlags`, `isNotificationAllowed`, and `formatFeatureFlags`.

Run the full verification suite:

```bash
npm run typecheck
npm test
```

---

## Verifying End-to-End with `npm run mock:poll`

You can verify your new notification end-to-end—without a live Soroban RPC node, deployed contracts, or a real Telegram bot token—using `npm run mock:poll`.

### How `npm run mock:poll` Works

`npm run mock:poll` runs `tsx src/mock-run.ts` with `MIMIR_PROFILE=mock`:
1. Starts an in-process Soroban JSON-RPC server (`startMockRpc` in `src/stellar/mock-rpc.ts`) bound to `127.0.0.1` on an ephemeral port (`--port 0`).
2. Loads the synthetic ledger scenario from `defaultMockScenario()` in `src/stellar/mock-rpc.ts`.
3. Runs `pollOnce(bot, config, store)` (`src/poller.ts`) with a stubbed Telegram broadcaster that prints every formatted MarkdownV2 notification and inline keyboard URL to stdout instead of calling `api.telegram.org`.
4. Persists the mock ledger cursor to `data/cursor.mock.json`.

### Adding Your Event to the Mock Scenario (`src/stellar/mock-rpc.ts`)

To see `claim_escalated` rendered by `npm run mock:poll`, add a `MockEventInput` entry to `defaultMockScenario()` in `src/stellar/mock-rpc.ts`:

```ts
{
  source: "market",
  ledger: 500_005,
  createdAt: "2026-03-29T12:00:25Z",
  txHash: TX(5),
  eventName: "claim_escalated",
  topics: [
    { kind: "u64", value: 42 },
    { kind: "address", value: CHALLENGER },
  ],
  fields: {
    bond: { kind: "i128", value: 50_000_000n },
    reason: { kind: "string", value: "Conflicting primary source" },
  },
}
```

### Running `npm run mock:poll`

1. **Reset the mock cursor** (if you have run `mock:poll` previously, delete `data/cursor.mock.json` so the poller replays from the start of the mock ledger window):
   ```bash
   rm -f data/cursor.mock.json
   ```

2. **Run the mock poll cycle**:
   ```bash
   npm run mock:poll
   ```

3. **Inspect the output**:
   `src/mock-run.ts` prints each broadcast message between `--- [mock broadcast #N -> @mimir_Local] ---` banners, showing the exact MarkdownV2 payload (`formatEvent`) and inline explorer button URL (`explorerKeyboard`), followed by a JSON summary:
   ```text
   --- [mock broadcast #5 -> @mimir_Local] ---
   🚨 *Claim \#42 escalated* by `GB7TAY…I2K4`
   Bond: *5 USDC* · Reason: _Conflicting primary source_
   `mimir-market` · Ledger `500005` · 2026\-03\-29 12:00 UTC
   [button] View on Explorer -> https://stellar.expert/explorer/testnet/tx/5555...
   ```

4. **Test failure and recovery paths with CLI flags**:
   `src/mock-run.ts` supports flags to verify resilience around your new event:
   - `npm run mock:poll -- --malformed` — injects a malformed event alongside valid events to verify `decodeEvent` skips bad XDR without crashing the batch.
   - `npm run mock:poll -- --fail-events=1` — simulates a transient RPC `getEvents` error before succeeding on retry.
   - `npm run mock:poll -- --stale-cursor` — simulates an out-of-retention cursor reset.
   - `npm run scan:mock` — runs the standalone `stellar-scan` CLI (`src/cli/stellar-scan.ts`) against `defaultMockScenario()` to inspect decoded events in table or `--jsonl` format.

---

## Contributor Checklist

Use this checklist when opening a pull request that adds a new contract notification type:

- [ ] **Types (`src/stellar/decode.ts`)**
  - [ ] Added payload variant to `MarketPayload`, `SquadPayload`, or `AdminPayload`.
  - [ ] Added typed event alias (e.g., `ClaimEscalatedEvent`) and added it to `MarketEvent` (if a market event).
  - [ ] If adding an admin event, updated `isAdminPayload` and `toAdminAuditRecord`.
- [ ] **Decoder (`src/stellar/decode.ts`)**
  - [ ] Added topic schema entry (`expectedCount` and `args`) to `MARKET_TOPIC_SCHEMAS` or `SQUAD_TOPIC_SCHEMAS` for `validateTopicSchema`.
  - [ ] Added decoder `case` in `decodeMarketV1` / `decodeMarketV2` (`MARKET_DECODERS`) or `decodeSquadV1` / `decodeSquadV2` (`SQUAD_DECODERS`), or `decodeAdmin`.
  - [ ] Used safe scalar helpers (`topicAt`, `num`, `amount`, `big`, `str`, `optStr`, `addr`, `optAddr`, `hex`).
- [ ] **Strings (`src/i18n.ts`)**
  - [ ] Added MarkdownV2 template function to `NOTIFICATION_MD` with all static reserved characters escaped (`\\`).
  - [ ] Added matching plain-text template function to `NOTIFICATION_PLAIN` with no Markdown syntax or backslash escapes.
- [ ] **Formatter (`src/notifications/format.ts` & `src/notifications/digest-grouping.ts`)**
  - [ ] Added `case` in `headline(event)` using `NOTIFICATION_MD`, `escapeMd`, `clip`, `usdc`, and `who`.
  - [ ] Added `case` in `plainHeadline(event)` using `NOTIFICATION_PLAIN`, `clip`, `plainUsdc`, and `plainWho`.
  - [ ] Verified `formatEvent`, `formatPlainTextEvent`, `formatLastEvent`, and `groupDigestEvents` (`src/notifications/digest-grouping.ts`) handle the new payload.
- [ ] **Filters & Feature Flags (`src/notifications/format.ts` & `src/notifications/featureFlags.ts`)**
  - [ ] Updated `eventAllowedByCategory(config, event)` in `src/notifications/format.ts` if the new event has a filterable `category` field.
  - [ ] Updated `NotificationFeatureFlags`, `DEFAULT_FEATURE_FLAGS`, `parseNotificationFeatureFlags`, `isNotificationAllowed`, and `formatFeatureFlags` in `src/notifications/featureFlags.ts` if the event requires a dedicated feature flag.
- [ ] **Fixtures & Mock RPC (`tests/fixtures/`, `scripts/gen-golden-corpus.mjs`, `src/stellar/mock-rpc.ts`)**
  - [ ] Added XDR builder function in `tests/fixtures/events.mjs`.
  - [ ] Added positive, negative, and boundary test cases to `tests/fixtures/events.json` (and added any new `bigint` field names to `MONEY_KEYS` in `tests/fixtures.test.mjs` and `tests/golden-corpus.test.mjs`).
  - [ ] Added golden snapshot cases to `scripts/gen-golden-corpus.mjs` and regenerated `tests/fixtures/golden/*.json`.
  - [ ] Added sample event to `defaultMockScenario()` in `src/stellar/mock-rpc.ts` and verified output with `npm run mock:poll`.
- [ ] **Tests (`tests/*.test.mjs`)**
  - [ ] Added decoder unit tests in `tests/decode.test.mjs` / `tests/decode-fixtures.test.mjs`.
  - [ ] Added topic schema tests in `tests/schema-validation.test.mjs`.
  - [ ] Added localization and MarkdownV2 lint tests in `tests/i18n.test.mjs` and `tests/markdown-lint.test.mjs`.
  - [ ] Added formatting and plain-text fallback tests in `tests/format.test.mjs` and `tests/plaintext-fallback.test.mjs`.
  - [ ] Updated golden corpus assertions in `tests/golden-corpus.test.mjs`.
  - [ ] Ran `npm run typecheck` and `npm test` cleanly.
- [ ] **Docs (`README.md`, `docs/`)**
  - [ ] Added the new event to the "What it watches" table in `README.md`.
  - [ ] Updated the supported event list in `docs/component-architecture.md` and `docs/contributor-fixtures.md`.
