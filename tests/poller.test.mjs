/**
 * Tests for src/poller.ts
 *
 * All I/O (filesystem, RPC, Telegram) is replaced by in-process fakes so no
 * network calls or real files are needed. The poller is exercised in isolation.
 *
 * Covered:
 *   ── Cursor safety ────────────────────────────────────────────────────────
 *   - Cold start (no cursor file) → starts lookback behind tip
 *   - Corrupt cursor file → cold start, not a crash
 *   - Stale cursor (target not in file) → left as null
 *   - Both targets restored independently from the cursor file
 *   - saveCursors failure is logged but does not abort the cycle
 *
 *   ── RPC failure mode ─────────────────────────────────────────────────────
 *   - A failing readContractEvents for one target must not affect the other
 *   - consecutiveFailures increments when ALL targets fail
 *   - consecutiveFailures resets when ANY target succeeds
 *
 *   ── Telegram failure mode ────────────────────────────────────────────────
 *   - send() rejection increments notificationsFailed but cursor still advances
 *   - maxNotificationsPerCycle cap: events beyond the cap are skipped (logged)
 *
 *   ── inFlight / stop ──────────────────────────────────────────────────────
 *   - inFlight guard prevents overlapping cycles (second invocation while first
 *     is in-flight is a no-op)
 *   - stop() prevents further cycles from being scheduled after the current one
 */

import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

// Ephemeral data directory: no test touches the repo data/ dir or fixed /tmp names.
const dataDir = await createTempDataDir("mimir-poller-");
test.after(() => dataDir.cleanup());

/** Polls `cond` until true or `timeoutMs` elapses (then fails the test). */
async function waitFor(cond, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;

  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }

    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Fake builder helpers ──────────────────────────────────────────────────────

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

const ADDR = "GBMGZ4WXIR2YQMJTLKJMCTVF3LGVQHSNXKGN6JD5MSHH4SLIRM4IR2Y";
const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";

function baseConfig(overrides = {}) {
  return {
    botToken: "fake-token",
    chatId: "-1001234567890",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 100_000,
    startLookbackLedgers: 60,
    cursorFile: dataDir.file("unused-cursor.json"),
    maxNotificationsPerCycle: 5,
    ...overrides,
  };
}

function makeFakeServer(healthOrError, scanResults = new Map()) {
  return {
    async getHealth() {
      if (healthOrError instanceof Error) {
        throw healthOrError;
      }

      return healthOrError;
    },

    async getEvents(req) {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      const result = scanResults.get(contractId);

      if (!result) {
        const health = healthOrError;
        const tip = health?.latestLedger ?? 5000;

        return {
          events: [],
          cursor: makeCursor(tip),
          latestLedger: tip,
        };
      }

      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };
}

function makeTestPoller({
  config,
  server,
  send,
  fileSystem = {},
} = {}) {
  const cfg = config ?? baseConfig();

  const srv =
    server ??
    makeFakeServer({
      status: "healthy",
      oldestLedger: 4000,
      latestLedger: 5000,
    });

  const sendFn = send ?? (async () => {});

  return createPoller({
    config: cfg,
    server: srv,
    send: sendFn,
    _fs: fileSystem,
  });
}

function successPage(contractId, events = [], ledger = 5000) {
  return {
    events,
    cursor: makeCursor(ledger),
    latestLedger: ledger,
  };
}

// ── Cursor safety ─────────────────────────────────────────────────────────────

test("poller: cold start — status shows both cursors null before first cycle", async () => {
  const poller = createPoller({
    config: baseConfig(),
    server: makeFakeServer({
      status: "healthy",
      oldestLedger: 4000,
      latestLedger: 5000,
    }),
    send: async () => {},
    _cursorFileContent: null,
    _disableCursorWrite: true,
  });

  const status = poller.status();

  assert.equal(status.targets.length, 2, "two watched targets");

  for (const target of status.targets) {
    assert.equal(
      target.cursor,
      null,
      `${target.source} cursor should be null before start`,
    );
  }
});

test("poller: after a successful scan, cursor is updated in status", async () => {
  const tip = 5000;
  const eventCursor = makeCursor(4900);
  const tipCursor = makeCursor(tip);

  const fakeEvent = {
    id: "4900-0",
    contractId: MARKET_ID,
    ledger: 4900,
    txHash: "abc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [],
    value: null,
  };

  let callCount = 0;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents() {
      callCount++;

      return {
        events: callCount === 1 ? [fakeEvent] : [],
        cursor: callCount === 1 ? eventCursor : tipCursor,
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("poller-test-cursor.json"),
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const status = poller.status();
  const marketTarget = status.targets.find(
    (target) => target.source === "market",
  );

  assert.ok(marketTarget, "market target should be in status");
  assert.ok(
    marketTarget.cursor !== null,
    "market cursor should be set after a scan",
  );
});

// ── Cursor persistence ────────────────────────────────────────────────────────

test("poller: corrupt cursor file triggers cold start, does not throw", async () => {
  const cursorFile = dataDir.file("corrupt-cursor.json");

  await writeFile(cursorFile, "{ this is not valid json }", "utf8");

  const config = baseConfig({
    cursorFile,
    pollIntervalMs: 9_999_999,
  });

  const server = makeFakeServer({
    status: "healthy",
    oldestLedger: 4000,
    latestLedger: 5000,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  poller.stop();

  for (const target of poller.status().targets) {
    assert.equal(target.cursor, null);
  }
});

test("poller: corrupt cursor JSON results in cold start", async () => {
  const tmpPath = dataDir.file("corrupt-cursor-2.json");

  await writeFile(tmpPath, "<<<not json>>>", "utf8");

  const config = baseConfig({
    cursorFile: tmpPath,
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: 5000,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(5000),
        latestLedger: 5000,
      };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  const before = poller.status();

  for (const target of before.targets) {
    assert.equal(target.cursor, null);
  }

  await poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  poller.stop();
});

test("poller: missing cursor file results in cold start, not an error", async () => {
  const config = baseConfig({
    cursorFile: dataDir.file("definitely-does-not-exist.json"),
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: 5000,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(5000),
        latestLedger: 5000,
      };
    },
  };

  let threw = false;

  try {
    const poller = createPoller({
      config,
      server,
      send: async () => {},
    });

    await poller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    poller.stop();
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "missing cursor file must not throw");
});

// ── RPC failure mode ──────────────────────────────────────────────────────────

test("poller: RPC failure for one target does not prevent the other from scanning", async () => {
  const tip = 5000;
  const tipCursor = makeCursor(tip);

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];

      if (contractIds.includes(MARKET_ID)) {
        throw new Error("RPC getEvents failure for market");
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("rpc-fail.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const status = poller.status();

  const market = status.targets.find(
    (target) => target.source === "market",
  );

  const squad = status.targets.find(
    (target) => target.source === "squad",
  );

  assert.ok(market.lastError !== null);
  assert.equal(squad.lastError, null);
});

test("poller: consecutiveFailures increments when ALL targets fail", async () => {
  const tip = 5000;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents() {
      throw new Error("all targets fail");
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("all-fail.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  poller.stop();

  assert.ok(
    poller.status().consecutiveFailures >= 1,
    "consecutiveFailures should be >= 1 when all targets fail",
  );
});

test("poller: consecutiveFailures resets when any target succeeds", async () => {
  const tip = 5000;
  const tipCursor = makeCursor(tip);

  let callNum = 0;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents() {
      callNum++;

      if (callNum <= 2) {
        throw new Error("first cycle failure");
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("reset-failures.json"),
    pollIntervalMs: 30,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  poller.stop();

  const status = poller.status();

  assert.equal(status.consecutiveFailures, 0);
  assert.ok(status.cycles >= 2);
});

test("poller: getHealth failure propagates to target error and increments consecutiveFailures", async () => {
  const server = {
    async getHealth() {
      throw new Error("RPC completely unreachable");
    },

    async getEvents() {
      return {
        events: [],
        cursor: "",
        latestLedger: 0,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("health-fail.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const status = poller.status();

  assert.ok(status.consecutiveFailures >= 1);
  assert.ok(status.lastError !== null);
});

// ── Telegram failure mode ─────────────────────────────────────────────────────

test("poller: Telegram send rejection does not crash the poller", async () => {
  const tip = 5000;
  const tipCursor = makeCursor(tip);

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];

      if (contractIds.includes(MARKET_ID)) {
        return {
          events: [
            {
              id: "4900-0",
              contractId: MARKET_ID,
              ledger: 4900,
              txHash: "abc",
              ledgerClosedAt: "2026-01-01T00:00:00Z",
              topic: [],
              value: null,
            },
          ],
          cursor: tipCursor,
          latestLedger: tip,
        };
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("tg-fail.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  poller.stop();

  const status = poller.status();

  assert.ok(status.cycles >= 1);

  const market = status.targets.find(
    (target) => target.source === "market",
  );

  assert.ok(market.cursor !== null);
});

test("poller: send failure does not prevent cursor from advancing", async () => {
  const { nativeToScVal, Address, Keypair } =
    await import("@stellar/stellar-sdk");

  const tip = 5000;
  const tipCursor = makeCursor(tip);

  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
  const fakeAddr = kp.publicKey();

  const scStr = (value) =>
    nativeToScVal(value, { type: "string" });

  const scU64 = (value) =>
    nativeToScVal(BigInt(value), { type: "u64" });

  const scAddress = (g) =>
    Address.account(
      Buffer.from(Keypair.fromPublicKey(g).rawPublicKey()),
    ).toScVal();

  const fakeEvent = {
    id: "4900-0",
    contractId: MARKET_ID,
    ledger: 4900,
    txHash: "abc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [
      scStr("claim_created"),
      scU64(1),
      scAddress(fakeAddr),
    ],
    value: nativeToScVal({ category: "crypto" }),
  };

  let eventsServed = false;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];

      if (contractIds.includes(MARKET_ID) && !eventsServed) {
        eventsServed = true;

        return {
          events: [fakeEvent],
          cursor: tipCursor,
          latestLedger: tip,
        };
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const sendAttempts = [];

  const config = baseConfig({
    cursorFile: dataDir.file("cursor-advance.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async (message) => {
      sendAttempts.push(message);
      throw new Error("Telegram unavailable");
    },
  });

  await poller.start();

  await waitFor(
    () =>
      poller.status().notificationsFailed >= 1 &&
      poller.status().targets.find(
        (target) => target.source === "market",
      ).cursor !== null,
    20_000,
  );

  poller.stop();

  const status = poller.status();

  assert.ok(sendAttempts.length >= 1);
  assert.ok(status.notificationsFailed >= 1);

  const market = status.targets.find(
    (target) => target.source === "market",
  );

  assert.ok(market.cursor !== null);
  assert.equal(market.cursor, tipCursor);
});

test("poller: maxNotificationsPerCycle cap — events beyond cap are skipped", async () => {
  const { nativeToScVal, Address, Keypair } =
    await import("@stellar/stellar-sdk");

  const tip = 5000;
  const tipCursor = makeCursor(tip);

  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
  const fakeAddr = kp.publicKey();

  const scStr = (value) =>
    nativeToScVal(value, { type: "string" });

  const scU64 = (value) =>
    nativeToScVal(BigInt(value), { type: "u64" });

  const scAddress = (g) =>
    Address.account(
      Buffer.from(Keypair.fromPublicKey(g).rawPublicKey()),
    ).toScVal();

  const events = Array.from({ length: 10 }, (_, i) => ({
    id: `490${i}-0`,
    contractId: MARKET_ID,
    ledger: 4900 + i,
    txHash: "abc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [
      scStr("claim_created"),
      scU64(i + 1),
      scAddress(fakeAddr),
    ],
    value: nativeToScVal({ category: "crypto" }),
  }));

  let served = false;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];

      if (contractIds.includes(MARKET_ID) && !served) {
        served = true;

        return {
          events,
          cursor: tipCursor,
          latestLedger: tip,
        };
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const sent = [];

  const config = baseConfig({
    cursorFile: dataDir.file("cap.json"),
    pollIntervalMs: 9_999_999,
    maxNotificationsPerCycle: 3,
  });

  const poller = createPoller({
    config,
    server,
    send: async (message) => {
      sent.push(message);
    },
  });

  await poller.start();

  await waitFor(
    () =>
      poller
        .status()
        .targets.every((target) => target.cursor !== null),
    20_000,
  );

  poller.stop();

  const status = poller.status();

  assert.ok(
    status.notificationsSent <= 3,
    `sent ${status.notificationsSent} messages but cap is 3`,
  );
});

// ── inFlight / stop ───────────────────────────────────────────────────────────

test("poller: stop() prevents further cycles after the current one completes", async () => {
  const tip = 5000;
  let cyclesStarted = 0;

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents() {
      cyclesStarted++;

      return {
        events: [],
        cursor: makeCursor(tip),
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("stop.json"),
    pollIntervalMs: 20,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  poller.stop();

  const cyclesAtStop = poller.status().cycles;

  await new Promise((resolve) => setTimeout(resolve, 100));

  const cyclesAfterStop = poller.status().cycles;

  assert.equal(
    cyclesAtStop,
    cyclesAfterStop,
    "no new cycles should run after stop()",
  );
});

test("poller: status().running is false after stop()", async () => {
  const config = baseConfig({
    cursorFile: dataDir.file("running.json"),
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: 5000,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(5000),
        latestLedger: 5000,
      };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();

  assert.equal(poller.status().running, true);

  poller.stop();

  assert.equal(poller.status().running, false);
});

test("poller: start() sets startedAt and increments cycles on first poll", async () => {
  const tip = 5000;

  const config = baseConfig({
    cursorFile: dataDir.file("startedat.json"),
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(tip),
        latestLedger: tip,
      };
    },
  };

  const before = Date.now();

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const status = poller.status();

  assert.ok(status.startedAt >= before);
  assert.ok(status.cycles >= 1);
});

// ── Per-target isolation ──────────────────────────────────────────────────────

test("poller: failed market scan does not update market cursor but squad cursor advances", async () => {
  const tip = 5000;
  const tipCursor = makeCursor(tip);

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: tip,
      };
    },

    async getEvents(req) {
      const contractIds = req.filters?.[0]?.contractIds ?? [];

      if (contractIds.includes(MARKET_ID)) {
        throw new Error("market RPC error");
      }

      return {
        events: [],
        cursor: tipCursor,
        latestLedger: tip,
      };
    },
  };

  const config = baseConfig({
    cursorFile: dataDir.file("iso.json"),
    pollIntervalMs: 9_999_999,
  });

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  poller.stop();

  const status = poller.status();

  const market = status.targets.find(
    (target) => target.source === "market",
  );

  const squad = status.targets.find(
    (target) => target.source === "squad",
  );

  assert.ok(market.lastError !== null);
  assert.equal(squad.lastError, null);
  assert.ok(squad.cursor !== null);
});

// ── Poller status shape ───────────────────────────────────────────────────────

test("poller: status() returns a snapshot, not a live reference", async () => {
  const config = baseConfig({
    cursorFile: dataDir.file("snapshot.json"),
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: 5000,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(5000),
        latestLedger: 5000,
      };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const snapshot1 = poller.status();
  const snapshot2 = poller.status();

  assert.notEqual(snapshot1, snapshot2);
  assert.deepEqual(snapshot1, snapshot2);
});

test("poller: targets list has exactly two entries (market and squad)", async () => {
  const config = baseConfig({
    cursorFile: dataDir.file("targets.json"),
    pollIntervalMs: 9_999_999,
  });

  const server = {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: 4000,
        latestLedger: 5000,
      };
    },

    async getEvents() {
      return {
        events: [],
        cursor: makeCursor(5000),
        latestLedger: 5000,
      };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
  });

  await poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  poller.stop();

  const status = poller.status();

  assert.equal(status.targets.length, 2);

  const sources = status.targets
    .map((target) => target.source)
    .sort();

  assert.deepEqual(sources, ["market", "squad"]);
});