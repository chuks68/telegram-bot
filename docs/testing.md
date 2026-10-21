# Testing Guide

This guide explains how the test suite is organised in the Mimir Telegram notifier, how to run tests locally, how to use existing test helpers and fakes, and how to write good, maintainable tests for new features and bug fixes.

---

## Testing Principles

1. **Deterministic and Hermetic**: Tests must run completely offline without hitting live Soroban RPC endpoints or the real Telegram Bot API.
2. **Credential-Free**: Tests never require a live `TELEGRAM_BOT_TOKEN`, secret signing keys, or real Stellar accounts.
3. **Isolated Filesystem**: Tests must never touch the repository's `data/` directory or rely on shared `/tmp` paths that collide across runs.
4. **Fast Feedback**: Tests use fake timers and in-memory fakes to avoid real wall-clock delays.
5. **Node Native**: The suite relies on Node's built-in test runner (`node:test`) and strict assertions (`node:assert/strict`) using standard ESM (`.mjs`).

---

## Test Suite Layout

```text
telegram-bot/
├── dist/                  # Compiled JavaScript artifacts (built from src/)
├── docs/                  # Documentation
│   └── testing.md         # This guide
├── src/                   # TypeScript source code
│   ├── drill.ts           # Reusable drill fakes and mock controllers
│   └── stellar/
│       └── mock-rpc.ts    # Standalone mock Soroban RPC server
└── tests/                 # Node.js native test files
    ├── helpers/           # Reusable test utilities
    │   ├── json-schema-lite.mjs
    │   └── temp-data.mjs
    ├── fixtures/          # Synthetic fixtures and golden files
    │   ├── events.mjs     # Synthetic Soroban event generator functions
    │   ├── events.json    # JSON event catalog
    │   ├── cursor-valid.json
    │   ├── cursor-stale.json
    │   └── cursor-corrupt.txt
    ├── <feature>.test.mjs # Dedicated test suites per feature / bugfix
    └── poller.test.mjs    # Core poller integration test suite
```

### Import Convention: Compile First, Import from `dist/`

The test suite runs plain ESM (`.mjs`) directly with Node's native runner without runtime transpilation (such as ts-node). All code under test is imported from the compiled `dist/` directory:

```javascript
// Correct: imports compiled code from dist/
import { createPoller } from "../dist/poller.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { createFakeTelegramNotifier, createFakeRpcServer } from "../dist/drill.js";
```

Because tests import from `dist/`, always run `npm run build` whenever you change files in `src/`.

---

## Running Tests

### Running the Full Suite

To build the TypeScript project and run the complete test suite:

```bash
npm test
```

This runs `npm run build && node --test --test-timeout=120000 tests/*.test.mjs`.

To run only the mock RPC suites:

```bash
npm run test:mock
```

To run TypeScript type checks:

```bash
npm run typecheck
```

### Running a Single Test File

During development, you should run only the test file you are actively working on rather than executing the entire suite:

1. **Build the latest TypeScript changes:**
   ```bash
   npm run build
   ```
   *(On Windows PowerShell where script execution is restricted, use `npm.cmd run build`)*

2. **Run the individual test file:**
   ```bash
   node --test tests/drill.test.mjs
   ```

3. **Filter tests by name pattern:**
   ```bash
   node --test --test-name-pattern="resets circuit breaker" tests/drill.test.mjs
   ```

4. **Adjust timeout if needed:**
   ```bash
   node --test --test-timeout=10000 tests/my-feature.test.mjs
   ```

---

## Ephemeral Temp Data Directories (`tests/helpers/temp-data.mjs`)

The poller reads and persists cursor positions to disk (e.g. `data/cursor.json`). Tests must **never** read or modify the real `data/` directory, nor should they use fixed paths in `/tmp` that could collide during concurrent test runs.

The helper `tests/helpers/temp-data.mjs` provides ephemeral directory management:

### 1. `createTempDataDir(prefix = "mimir-data-")`

Creates an ephemeral directory under the OS temp directory and returns an object with:
- `root`: Absolute path to the ephemeral directory.
- `file(name)`: Helper resolving the absolute path of a file inside the directory.
- `cleanup()`: Removes the directory recursively with retry logic (`maxRetries: 10, retryDelay: 50`) to accommodate asynchronous cursor writes completing just after cycle exit.

Example with `test.after`:

```javascript
import test from "node:test";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const dataDir = await createTempDataDir("mimir-my-feature-");
test.after(() => dataDir.cleanup());

test("persists cursor to isolated file", async () => {
  const cursorFile = dataDir.file("cursor.json");
  // test logic using cursorFile ...
});
```

### 2. `withTempDataDir(fn, prefix)`

Runs `fn(dir)` and guarantees `dir.cleanup()` is invoked in a `finally` block, even if `fn` throws:

```javascript
import test from "node:test";
import { withTempDataDir } from "./helpers/temp-data.mjs";

test("processes and safely cleans up", async () => {
  await withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    // test logic ...
  }, "mimir-scoped-test-");
});
```

---

## Fake Clocks and Deterministic Timing

Real delays (`setTimeout`, interval sleeps, exponential backoff) slow down test runs and introduce flakiness. Two mechanisms exist for deterministic timing:

### 1. Injected Clock Pattern (`{ now, sleep }`)

Poller routines (such as `createPoller`, `waitForStartupHealth`, and backoff schedules) accept injectable clock functions.

A lightweight fake clock looks like this:

```javascript
function fakeClock(start = 0) {
  let currentTime = start;
  return {
    now: () => currentTime,
    advance: (ms) => {
      currentTime += ms;
    },
    // Sleep resolves immediately while advancing the internal simulated clock
    sleep: async (ms) => {
      currentTime += ms;
    },
  };
}
```

Passing `now: clock.now, sleep: clock.sleep` allows milliseconds or hours of backoff to execute instantaneously:

```javascript
const clock = fakeClock(1_000);
const poller = createPoller({
  config,
  send: notifier.send,
  server: rpcServer,
  now: clock.now,
  sleep: clock.sleep,
});

await poller.pollOnce();
```

### 2. Node Test Runner Mock Timers (`node:test`)

For code that relies on Node's global timers, use `t.mock.timers`:

```javascript
import test from "node:test";

test("timer-dependent feature", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  try {
    // Trigger scheduled action ...
    t.mock.timers.tick(5_000);
    // Assert expectations after 5 seconds have passed
  } finally {
    t.mock.timers.reset();
  }
});
```

---

## Mock RPC Usage

Two levels of RPC mocking are available depending on whether you need a loopback HTTP server or an in-memory SDK stub.

### Level 1: Standalone HTTP Mock RPC (`dist/stellar/mock-rpc.js`)

`startMockRpc(options)` launches a real loopback HTTP server serving the JSON-RPC methods used by the bot (`getHealth`, `getEvents`, `getNetwork`). It models ledger retention floors, cursor pagination, and stale cursors:

```javascript
import { startMockRpc, defaultMockScenario } from "../dist/stellar/mock-rpc.js";

test("walks pages with mock RPC", async () => {
  const rpc = await startMockRpc({
    port: 0, // OS-assigned port
    scenario: defaultMockScenario(),
  });

  try {
    const rpcUrl = rpc.url;
    // Exercise poller or scanner against rpcUrl
  } finally {
    await rpc.stop();
  }
});
```

You can inject faults into the mock RPC using `MockFailure`:
- `kind`: `"error"` | `"http-500"` | `"rate-limit"` | `"stale-cursor"`
- `method`: `"getEvents"` | `"getHealth"`
- `count`: number of failures before recovering

### Level 2: In-Memory Fake RPC Server (`dist/drill.js`)

For unit tests that do not need network sockets, `createFakeRpcServer()` provides an in-memory implementation of `@stellar/stellar-sdk`'s `rpc.Server`:

```javascript
import { createFakeRpcServer, makeDrillCursor } from "../dist/drill.js";
import { claimCreatedEvent } from "./fixtures/events.mjs";

test("in-memory RPC fake delivers events", async () => {
  const rpcController = createFakeRpcServer(1, 100);

  // Queue synthetic events for a contract
  rpcController.queueEvents("CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", [
    claimCreatedEvent({ ledger: 42 }),
  ]);

  // Inspect recorded calls
  const calls = rpcController.getRecordedCalls();

  // Control empty pages or simulate failures
  rpcController.setEmptyPagesUntilEvents(2);
  rpcController.setFailure(() => new Error("RPC temporary failure"));
  rpcController.clearFailure();
});
```

`makeDrillCursor(ledger, index)` can be used to generate valid synthetic cursor strings.

---

## Fake Telegram Notifiers

Tests must never contact the Telegram API or require a valid Telegram Bot Token.

### 1. Minimal In-Memory Send Function

The simplest notifier is an async function that pushes formatted strings into an array:

```javascript
const sent = [];
const send = async (text) => {
  sent.push(text);
};
```

To test send errors:

```javascript
const sendFailing = async () => {
  throw new Error("Telegram API unavailable (500)");
};
```

### 2. Fake Telegram Notifier Controller (`dist/drill.js`)

`createFakeTelegramNotifier()` provides a ready-made fake notifier with failure injection and credential leakage assertions:

```javascript
import { createFakeTelegramNotifier } from "../dist/drill.js";

test("fake notifier with failure simulation and secret check", async () => {
  const notifier = createFakeTelegramNotifier();

  // 1. Normal delivery
  await notifier.send("Hello world");
  assert.equal(notifier.sent.length, 1);

  // 2. Failure simulation
  notifier.setFailureMode("fail-count", 2); // Fails twice then succeeds
  notifier.setFailureMode("fail-always");   // Always rejects

  // 3. Secret leakage check
  // Asserts that no sensitive bot tokens or private keys appear in sent messages
  notifier.assertNoSecrets(["secret-token", "<stellar-secret-seed>"]);
});
```

---

## Other Existing Helpers

- **`tests/helpers/json-schema-lite.mjs`**: Lightweight, zero-dependency schema validator (`validate(schema, value)`) used to verify health reports and audit outputs conform to expected JSON schemas without pulling in heavyweight schema dependencies.
- **`tests/fixtures/events.mjs`**: Programmatic builders for synthetic Soroban events (e.g. `claimCreatedEvent`, `claimChallengedEvent`, `squadMarketCreatedEvent`) with valid SDK `xdr.ScVal` structures. Exports deterministic keypairs (`CREATOR_KP`, `CHALL_KP`, `CAPTAIN_KP`, `FEE_KP`) and contract IDs (`MARKET_CONTRACT`, `SQUAD_CONTRACT`).

---

## Why Each Issue Should Add a New Test File (Rather Than Extending `tests/poller.test.mjs`)

When implementing a feature or fixing a bug, **always add a new test file** (e.g. `tests/volume-series.test.mjs`, `tests/chain-clock.test.mjs`) instead of adding test cases to `tests/poller.test.mjs`.

Here is why:

1. **Avoid Monolithic Bloat**: `tests/poller.test.mjs` is nearly 2,000 lines long. Appending more tests creates unmaintainable monster files that are slow to navigate, parse, and reason about.
2. **Prevent Merge Conflicts**: Multiple contributors working concurrently on different PRs will constantly conflict if everyone modifies `tests/poller.test.mjs`. Distinct test files merge cleanly without rebasing friction.
3. **Failure Isolation & Blast Radius**: If a test file has a syntax error or catastrophic failure, it does not prevent unrelated test suites from running.
4. **Fast, Targeted Feedback**: Contributors and reviewers can run only the specific test file (`node --test tests/my-feature.test.mjs`) in milliseconds during local iteration rather than running the entire monolithic suite.
5. **Clean Lifecycle & State Boundaries**: In a monolithic file, shared setup (such as module-level `dataDir`, mock registrations, or environment overrides) risks cross-test contamination. Separate files ensure clean V8 processes with zero state leakage.
6. **Self-Documenting History & Traceability**: A file dedicated to an issue (or feature) serves as living documentation of that specific requirement. If the feature is ever modified or deprecated, its tests are easily updated or removed in isolation.

---

## Template Test File

Here is an idiomatic, copy-pasteable template for creating a new test file:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

// 1. Helpers from tests/helpers/
import { createTempDataDir } from "./helpers/temp-data.mjs";

// 2. Compiled production code from dist/
import { createPoller } from "../dist/poller.js";
import { createDrillConfig, createFakeRpcServer, createFakeTelegramNotifier } from "../dist/drill.js";

// 3. Fixtures from tests/fixtures/
import { claimCreatedEvent } from "./fixtures/events.mjs";

// Ephemeral directory for this test suite
const dataDir = await createTempDataDir("mimir-my-feature-");
test.after(() => dataDir.cleanup());

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    sleep: async (ms) => { now += ms; },
  };
}

test("my-feature: polls events, advances cursor, and delivers notifications", async () => {
  const cursorFile = dataDir.file("cursor.json");
  const clock = fakeClock(1_000);
  const notifier = createFakeTelegramNotifier();
  const rpcController = createFakeRpcServer(1, 100);

  const config = createDrillConfig(cursorFile, {
    pollIntervalMs: 50,
  });

  // Queue a synthetic event within the lookback window (tip is 100, lookback is 10)
  rpcController.queueEvents(config.marketContractId, [
    claimCreatedEvent({ ledger: 95 }),
  ]);

  const poller = createPoller({
    config,
    send: notifier.send,
    server: rpcController.server,
    now: clock.now,
    sleep: clock.sleep,
  });

  // Execute a single poll cycle
  await poller.pollOnce();

  // Assert status and delivery
  const status = poller.status();
  assert.equal(status.consecutiveFailures, 0, "cycle should succeed");
  assert.equal(notifier.sent.length, 1, "should send one notification");
  assert.match(notifier.sent[0], /New claim/i);

  // Verify secrets are never leaked
  notifier.assertNoSecrets([config.botToken]);
});
```
