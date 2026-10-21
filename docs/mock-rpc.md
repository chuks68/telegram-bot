# Mock RPC scenarios

The local mock implements the Soroban JSON-RPC calls used by Mimir so that
contributors can exercise pagination, decoding, cursor recovery, and failures
without Testnet or Telegram credentials. It is read-only, has no signing keys,
and binds to `127.0.0.1` by default. Do not expose it as a public service or use
it as a production RPC.

## Run the built-in scenario

```bash
npm run mock:rpc                         # listen on 127.0.0.1:8420
npm run scan:mock                        # scan a separately running mock
npm run mock:poll                        # run the mock and poller together
npm run mock:poll -- --port 0            # let the OS choose an ephemeral port
npm run mock:poll -- --malformed         # add one undecodable event
npm run mock:poll -- --fail-events error # fail every getEvents call
```

The mock profile uses fixture contract ids and `data/cursor.mock.json`, so its
cursor cannot overwrite the normal bot cursor. Explicit environment variables
take precedence over mock-profile defaults.

## Scenario API

Pass a `MockScenario` to `startMockRpc({ scenario })`. All four top-level
fields are required:

| Field | Type | Meaning |
| --- | --- | --- |
| `latestLedger` | `number` | Current chain tip. Requests and cursors cannot advance beyond it. |
| `oldestLedger` | `number` | Oldest retained ledger. A start ledger or cursor below it is rejected. |
| `ledgersPerPage` | `number` | Maximum ledger span walked by one `getEvents` response. It is truncated and clamped to at least 1. |
| `events` | `MockEventInput[]` | Contract events available within the retained ledger window. |

Each entry in `events` has this shape:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `source` | `"market" \| "squad"` | No | Selects a fixture contract id; defaults to `market`. |
| `contractId` | `string` | No | Uses an explicit contract id and overrides `source`. |
| `ledger` | `number` | Yes | Event ledger; it must be a positive safe integer. |
| `eventName` | `string` | Yes | Encoded as topic 0 using a Soroban symbol. |
| `topics` | `MockValue[]` | No | Topics after the event name, in declaration order; defaults to `[]`. |
| `fields` | `Record<string, MockValue>` | No | Event value map; defaults to `{}` and encodes each key as a symbol. |

Events are sorted by ledger. Their per-ledger sequence, transaction hash,
close time, and paging cursor are generated deterministically. An event outside
`oldestLedger..latestLedger` is not returned.

### Value encodings

Use these `MockValue` forms in `topics` and `fields`:

| TypeScript value | Soroban value |
| --- | --- |
| `string` | string |
| non-negative safe-integer `number` | `u64` |
| `bigint` | `i128` |
| `{ address: string }` | address |
| `{ bytes: string }` | bytes decoded from the hex string |
| `{ symbol: string }` | symbol |

Use a TypeScript object rather than JSON for scenarios that contain `bigint`;
JSON cannot serialize values such as `20_000_000n`. A `number` must be
non-negative and satisfy `Number.isSafeInteger`, while a `bigint` is the
appropriate representation for signed amounts encoded as `i128`.

### Complete example

```ts
import {
  startMockRpc,
  type MockScenario,
} from "../src/stellar/mock-rpc.js";

const scenario = {
  latestLedger: 1000,
  oldestLedger: 900,
  ledgersPerPage: 50,
  events: [
    {
      source: "market",
      ledger: 992,
      eventName: "claim_challenged",
      topics: [
        7,
        { address: "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV" },
      ],
      fields: { stake: 20_000_000n },
    },
  ],
} satisfies MockScenario;

const mock = await startMockRpc({ port: 0, scenario });
console.log(mock.url);

// Run the scanner or poller against mock.url, then clean up.
await mock.close();
```

The built-in `defaultMockScenario()` uses ledgers 900 through 1000, walks 50
ledgers per page, and provides ten market and squad events at ledgers 990
through 1000. One is an `oracle_changed` event, which exercises the
non-notification path for decoded admin events.

## Failure injection

Failures are configured independently for `getHealth` and `getEvents`:

```ts
const mock = await startMockRpc({
  port: 0,
  scenario,
  failures: {
    getEvents: { kind: "rate-limit", times: 2 },
  },
});

mock.setFailure("getEvents", { kind: "stale-cursor", times: 1 });
mock.setFailure("getEvents", null); // clear it
```

| Kind | HTTP status | JSON-RPC code | Behavior |
| --- | ---: | ---: | --- |
| `error` | 200 | `-32603` | Returns an in-band internal RPC error. |
| `http-500` | 500 | `-32603` | Returns a transport-shaped server error. |
| `rate-limit` | 429 | `-32005` | Returns a transport-shaped rate-limit error. |
| `stale-cursor` | 200 | `-32000` | Makes `getEvents` reject a nonempty cursor as outside the retained window. |

Omitting `times` keeps the failure active until it is cleared or the process
exits. A positive `times: N` applies to the next N matching requests and then
auto-clears. A value of zero or less is inactive.

`stale-cursor` only rejects a `getEvents` request that contains a cursor. A
matching method call spends a finite budget before kind-specific handling, so
cursorless `getEvents` calls can consume a `stale-cursor` budget while
succeeding. The kind does not fail `getHealth`; configuring it for health is
inert, although health calls still consume a finite budget. CLI failures do
not set `times`, so they remain active for the process lifetime.

## CLI flags and precedence

The same flags are accepted by `mock:rpc` and `mock:poll`:

| Flag | Effect |
| --- | --- |
| `--port <0-65535>` | Select the loopback port; `0` requests an ephemeral port. |
| `--fail-events <kind>` | Set a `getEvents` failure. |
| `--fail-health <kind>` | Set a `getHealth` failure independently. |
| `--stale-cursor` | Shorthand for a `getEvents` `stale-cursor` failure. |
| `--rate-limit` | Shorthand for a `getEvents` `rate-limit` failure. |
| `--fail-rpc` | Shorthand for a `getEvents` `error` failure. |
| `--malformed` | Append one undecodable event at `latestLedger`. |

`<kind>` is one of `error`, `http-500`, `rate-limit`, or `stale-cursor`.
Explicit `--fail-events` wins over every shorthand. When multiple shorthands
are present, the fixed priority is `--stale-cursor`, then `--rate-limit`, then
`--fail-rpc`, regardless of argument order. `--fail-health` is independent.

Repeated value flags use their first occurrence. Unknown flags are ignored.
An invalid port, missing failure kind, or unknown failure kind prints an error
and exits with status 2. A bare `--port` currently uses the default port 8420.

## Pagination and cursor behavior

- `cursor` and `startLedger` are mutually exclusive.
- A start ledger or cursor below `oldestLedger` is rejected rather than
  returning an empty page; a position above `latestLedger` is also rejected.
- The default event limit is 100 when the request omits it. Supplied limits
  are truncated and clamped to the range 1 through 1000.
- `ledgersPerPage` bounds the ledger window independently of the event limit.
  An empty window returns a cursor at the end of that window. At a terminal
  resumed position, that cursor can remain unchanged; the client uses its
  cursor-stall guard to stop the walk.
- Cursors are opaque resume tokens. Tests should carry them forward unchanged
  instead of constructing or parsing them.

## Validation

The mock and its documentation require no live network or credentials:

```bash
npm ci
npm run typecheck
npm run test:mock
npm test
git diff --check
```
