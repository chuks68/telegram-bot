import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import {
  COUNTERS_SCHEMA_VERSION,
  buildCountersFile,
  createPoller,
  isValidCountersFile,
  parseCountersFile,
} from "../dist/poller.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
const CREATOR = kp.publicKey();
const MARKET_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const MARKET_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM";
const SQUAD_CONTRACT_A = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD2KM";
const SQUAD_CONTRACT_B = "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEED2KM";

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

function baseConfig(dataDir, overrides = {}) {
  return {
    botToken: "123456:fake-token-secret",
    chatId: "-1001234",
    chatIds: ["-1001234"],
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    marketContractId: MARKET_CONTRACT_A,
    marketContractVersion: "v1",
    squadContractId: SQUAD_CONTRACT_A,
    squadContractVersion: "v1",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 100,
    cursorFile: path.join(dataDir, "cursors.json"),
    countersFile: path.join(dataDir, "counters.json"),
    statusFile: path.join(dataDir, "status.json"),
    explorerUrl: "https://stellar.expert/explorer/testnet",
    maxNotificationsPerCycle: 20,
    dedupWindow: 200,
    logSampleWindowMs: 60_000,
    logSampleMaxPerWindow: 3,
    ...overrides,
  };
}

function makeRawEvent({
  id = "0001000-0001",
  ledger = 1000,
  eventName = "claim_created",
  claimId = 1n,
} = {}) {
  const creatorScVal = Address.account(
    Buffer.from(Keypair.fromPublicKey(CREATOR).rawPublicKey()),
  ).toScVal();
  return {
    id,
    ledger,
    ledgerClosedAt: "2026-03-26T12:00:00Z",
    txHash: "a".repeat(64),
    topic:
      eventName === "claim_created"
        ? [
            nativeToScVal("claim_created", { type: "string" }),
            nativeToScVal(claimId, { type: "u64" }),
            creatorScVal,
          ]
        : [nativeToScVal(eventName, { type: "string" })],
    value: nativeToScVal({ category: "crypto" }),
  };
}

function makeServer(marketPages = [[]], squadPages = [[]]) {
  let marketCalls = 0;
  let squadCalls = 0;
  return {
    async getHealth() {
      return { status: "healthy", latestLedger: 1200, oldestLedger: 500 };
    },
    async getEvents(req) {
      const cid = req.filters?.[0]?.contractIds?.[0];
      if (cid === MARKET_CONTRACT_A || cid === MARKET_CONTRACT_B) {
        const events = marketPages[marketCalls] ?? [];
        marketCalls += 1;
        return {
          events,
          latestLedger: 1200,
          oldestLedger: 500,
          cursor: makeCursor(1200, marketCalls),
        };
      }
      const events = squadPages[squadCalls] ?? [];
      squadCalls += 1;
      return {
        events,
        latestLedger: 1200,
        oldestLedger: 500,
        cursor: makeCursor(1200, 100 + squadCalls),
      };
    },
  };
}

const fastSendOptions = {
  maxSendRetries: 1,
  initialBackoffMs: 0,
  maxBackoffMs: 0,
  sendSpacingMs: 0,
};

test("persisted counters: schema helpers validate and serialize v1 files", () => {
  const doc = buildCountersFile(
    { marketContractId: MARKET_CONTRACT_A, squadContractId: SQUAD_CONTRACT_A },
    {
      cycles: 4,
      notificationsSent: 7,
      notificationsFailed: 2,
      eventsSkipped: 3,
    },
    "2026-03-26T12:00:00.000Z",
  );

  assert.equal(doc.version, COUNTERS_SCHEMA_VERSION);
  assert.equal(isValidCountersFile(doc), true);

  const parsed = parseCountersFile(JSON.stringify(doc));
  assert.deepEqual(parsed, doc);

  assert.throws(() => parseCountersFile("{not-json"), /invalid JSON/);
  assert.throws(
    () => parseCountersFile(JSON.stringify({ ...doc, version: 99 })),
    /unsupported schema version 99/,
  );
  assert.throws(
    () =>
      parseCountersFile(
        JSON.stringify({
          ...doc,
          counters: { ...doc.counters, cycles: -1 },
        }),
      ),
    /failed schema validation/,
  );
});

test(
  "persisted counters: restores cumulative counters across restarts and exposes sinceStart + cumulative in snapshot",
  async () => {
    await withTempDataDir(async (temp) => {
      const cfg = baseConfig(temp.root);

      // Run 1: 2 cycles, 1 sent, 1 failed, 1 skipped (unknown event)
      let sendCall = 0;
      const firstServer = makeServer([
        [
          makeRawEvent({ id: "0001001-0001", ledger: 1001, eventName: "claim_created" }),
          makeRawEvent({ id: "0001002-0002", ledger: 1002, eventName: "claim_created" }),
          makeRawEvent({ id: "0001003-0003", ledger: 1003, eventName: "mystery_unknown_event" }),
        ],
        [],
      ]);

      const first = createPoller({
        config: cfg,
        server: firstServer,
        sendOptions: fastSendOptions,
        send: async () => {
          sendCall += 1;
          if (sendCall === 2) {
            throw new Error("Telegram temporary error");
          }
        },
        now: () => 1_700_000_000_000,
      });

      await first.loadCursors();
      await first.loadCounters();
      await first.runCycle();
      await first.runCycle();
      await first.shutdown({ timeoutMs: 500 });

      const firstStatus = first.status();
      assert.deepEqual(firstStatus.sinceStart, {
        cycles: 2,
        notificationsSent: 1,
        notificationsFailed: 1,
        eventsSkipped: 1,
      });
      assert.deepEqual(firstStatus.cumulative, {
        cycles: 2,
        notificationsSent: 1,
        notificationsFailed: 1,
        eventsSkipped: 1,
      });

      // Verify atomic write left no .tmp files and wrote versioned JSON
      const filesAfterFirst = await readdir(temp.root);
      assert.deepEqual(
        filesAfterFirst.filter((f) => f.endsWith(".tmp")),
        [],
      );
      const rawCounters = JSON.parse(await readFile(cfg.countersFile, "utf8"));
      assert.equal(rawCounters.version, COUNTERS_SCHEMA_VERSION);
      assert.deepEqual(rawCounters.contracts, {
        marketContractId: MARKET_CONTRACT_A,
        squadContractId: SQUAD_CONTRACT_A,
      });
      assert.deepEqual(rawCounters.counters, {
        cycles: 2,
        notificationsSent: 1,
        notificationsFailed: 1,
        eventsSkipped: 1,
      });

      // Run 2: restart with same contract IDs, run 1 more cycle with 1 sent and 1 skipped
      const secondServer = makeServer([
        [
          makeRawEvent({ id: "0001010-0001", ledger: 1010, eventName: "claim_created" }),
          makeRawEvent({ id: "0001011-0002", ledger: 1011, eventName: "unrecognized_event" }),
        ],
      ]);

      const second = createPoller({
        config: cfg,
        server: secondServer,
        sendOptions: fastSendOptions,
        send: async () => {},
        now: () => 1_700_000_010_000,
      });

      await second.loadCursors();
      await second.loadCounters();

      // Immediately after loadCounters (before any cycle in process #2)
      const preCycleSnap = second.snapshot();
      assert.deepEqual(preCycleSnap.sinceStart, {
        cycles: 0,
        notificationsSent: 0,
        notificationsFailed: 0,
        eventsSkipped: 0,
      });
      assert.deepEqual(preCycleSnap.cumulative, {
        cycles: 2,
        notificationsSent: 1,
        notificationsFailed: 1,
        eventsSkipped: 1,
      });

      // Run 1 cycle on the restarted poller
      await second.runCycle();
      await second.shutdown({ timeoutMs: 500 });

      const secondStatus = second.status();
      assert.deepEqual(secondStatus.sinceStart, {
        cycles: 1,
        notificationsSent: 1,
        notificationsFailed: 0,
        eventsSkipped: 1,
      });
      assert.deepEqual(secondStatus.cumulative, {
        cycles: 3,
        notificationsSent: 2,
        notificationsFailed: 1,
        eventsSkipped: 2,
      });
      assert.equal(secondStatus.cycles, 3);
      assert.equal(secondStatus.notificationsSent, 2);
      assert.equal(secondStatus.notificationsFailed, 1);
      assert.equal(secondStatus.eventsSkipped, 2);

      // Verify status snapshot on disk also exposes both sinceStart and cumulative
      const diskStatus = JSON.parse(await readFile(cfg.statusFile, "utf8"));
      assert.deepEqual(diskStatus.sinceStart, {
        cycles: 1,
        notificationsSent: 1,
        notificationsFailed: 0,
        eventsSkipped: 1,
      });
      assert.deepEqual(diskStatus.cumulative, {
        cycles: 3,
        notificationsSent: 2,
        notificationsFailed: 1,
        eventsSkipped: 2,
      });
    });
  },
);

test(
  "persisted counters: corrupt counters file never blocks startup and starts fresh",
  async () => {
    await withTempDataDir(async (temp) => {
      const cfg = baseConfig(temp.root);
      const corruptInputs = [
        "{corrupt-json",
        JSON.stringify({ version: 99, contracts: {}, counters: {} }),
        JSON.stringify({
          version: 1,
          updatedAt: "2026-03-26T00:00:00.000Z",
          contracts: { marketContractId: MARKET_CONTRACT_A, squadContractId: SQUAD_CONTRACT_A },
          counters: { cycles: "bad", notificationsSent: -5 },
        }),
      ];

      for (const [idx, badPayload] of corruptInputs.entries()) {
        await writeFile(cfg.countersFile, badPayload, "utf8");

        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(" "));

        try {
          const poller = createPoller({
            config: cfg,
            server: makeServer([
              [makeRawEvent({ id: `0001050-${idx + 1}`, ledger: 1050 + idx, claimId: BigInt(idx + 1) })],
            ]),
            sendOptions: fastSendOptions,
            send: async () => {},
          });

          await poller.loadCursors();
          await poller.loadCounters();

          // Startup must not throw and counters must start fresh at 0
          assert.deepEqual(poller.status().cumulative, {
            cycles: 0,
            notificationsSent: 0,
            notificationsFailed: 0,
            eventsSkipped: 0,
          });
          assert.ok(
            warnings.some((line) => line.includes("corrupt or invalid") && line.includes("starting fresh")),
            `expected corrupt-counters warning in logs, got: ${warnings.join("\n")}`,
          );

          await poller.runCycle();
          await poller.shutdown({ timeoutMs: 500 });

          // Subsequent cycle writes a clean valid counters file
          const repaired = parseCountersFile(await readFile(cfg.countersFile, "utf8"));
          assert.equal(repaired.counters.cycles, 1);
          assert.equal(repaired.counters.notificationsSent, 1);
        } finally {
          console.warn = origWarn;
        }
      }
    });
  },
);

test(
  "persisted counters: contract id changes reset counters and log why",
  async () => {
    await withTempDataDir(async (temp) => {
      const cfgInitial = baseConfig(temp.root);
      const initialDoc = buildCountersFile(
        { marketContractId: MARKET_CONTRACT_A, squadContractId: SQUAD_CONTRACT_A },
        {
          cycles: 15,
          notificationsSent: 42,
          notificationsFailed: 3,
          eventsSkipped: 9,
        },
        "2026-03-26T12:00:00.000Z",
      );
      await writeFile(cfgInitial.countersFile, JSON.stringify(initialDoc, null, 2), "utf8");

      // Case 1: marketContractId changed
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        const cfgMarketChanged = baseConfig(temp.root, {
          marketContractId: MARKET_CONTRACT_B,
        });
        const poller = createPoller({
          config: cfgMarketChanged,
          server: makeServer([[]]),
          sendOptions: fastSendOptions,
          send: async () => {},
        });

        await poller.loadCursors();
        await poller.loadCounters();

        assert.deepEqual(poller.status().cumulative, {
          cycles: 0,
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
        });
        assert.deepEqual(poller.status().sinceStart, {
          cycles: 0,
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
        });
        assert.ok(
          warnings.some(
            (line) =>
              line.includes("contract ids changed") &&
              line.includes(MARKET_CONTRACT_A) &&
              line.includes(MARKET_CONTRACT_B),
          ),
          `expected contract-change warning, got: ${warnings.join("\n")}`,
        );

        await poller.runCycle();
        await poller.shutdown({ timeoutMs: 500 });

        const savedAfterMarketChange = parseCountersFile(
          await readFile(cfgMarketChanged.countersFile, "utf8"),
        );
        assert.equal(savedAfterMarketChange.contracts.marketContractId, MARKET_CONTRACT_B);
        assert.equal(savedAfterMarketChange.counters.cycles, 1);
        assert.equal(savedAfterMarketChange.counters.notificationsSent, 0);

        // Case 2: squadContractId changed
        warnings.length = 0;
        const cfgSquadChanged = baseConfig(temp.root, {
          marketContractId: MARKET_CONTRACT_B,
          squadContractId: SQUAD_CONTRACT_B,
        });
        const poller2 = createPoller({
          config: cfgSquadChanged,
          server: makeServer([[]]),
          sendOptions: fastSendOptions,
          send: async () => {},
        });

        await poller2.loadCounters();
        assert.deepEqual(poller2.status().cumulative, {
          cycles: 0,
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
        });
        assert.ok(
          warnings.some(
            (line) =>
              line.includes("contract ids changed") &&
              line.includes(SQUAD_CONTRACT_A) &&
              line.includes(SQUAD_CONTRACT_B),
          ),
          `expected squad contract-change warning, got: ${warnings.join("\n")}`,
        );
      } finally {
        console.warn = origWarn;
      }
    });
  },
);
