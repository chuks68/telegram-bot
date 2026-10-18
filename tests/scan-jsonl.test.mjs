import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readContractEvents } from "../dist/stellar/events.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import {
  MARKET_CONTRACT,
  claimCreatedEvent,
  claimChallengedEvent,
  claimResolvedEvent,
  marketSettledEvent,
  emptyTopicsEvent,
} from "./fixtures/events.mjs";

const execFileAsync = promisify(execFile);
const EVENTS_CLI = fileURLToPath(new URL("../dist/stellar/events.js", import.meta.url));

function makeCursor(ledger, index = 0) {
  const toid = BigInt(ledger) << 32n;
  return `${toid}-${index}`;
}

function createFixtureServer(events, { oldestLedger = 100, latestLedger = 500 } = {}) {
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger, latestLedger };
    },
    async getEvents() {
      return {
        events,
        cursor: makeCursor(latestLedger),
        latestLedger,
      };
    },
  };
}

test("formatScanJsonl emits one valid JSON line per decoded event and a final summary line from a fixture scan", async () => {
  const rawEvents = [
    claimCreatedEvent({ id: makeCursor(101, 0), ledger: 101 }),
    claimChallengedEvent({ id: makeCursor(102, 0), ledger: 102, stake: 25_000_000n }),
    claimChallengedEvent({ id: makeCursor(103, 0), ledger: 103, stake: 50_000_000n }),
    claimResolvedEvent({ id: makeCursor(104, 0), ledger: 104 }),
    marketSettledEvent({ id: makeCursor(105, 0), ledger: 105 }),
    emptyTopicsEvent({ id: makeCursor(106, 0), ledger: 106 }),
  ];

  const server = createFixtureServer(rawEvents);
  const scan = await readContractEvents(
    server,
    { source: "market", contractId: MARKET_CONTRACT },
    { startLedger: 100 },
  );

  assert.equal(scan.events.length, 6);

  const output = formatScanJsonl(scan.events);
  assert.equal(output.endsWith("\n"), true);

  const rawLines = output.trimEnd().split("\n");
  assert.equal(rawLines.length, scan.events.length + 1);

  const parsedLines = rawLines.map((line) => JSON.parse(line));

  for (let i = 0; i < scan.events.length; i++) {
    const line = parsedLines[i];
    assert.equal(line.type, "event");
    assert.equal(line.source, "market");
    assert.equal(line.contractId, MARKET_CONTRACT);
    assert.equal(line.ledger, scan.events[i].ledger);
    assert.equal(line.payload.name, scan.events[i].payload.name);
  }

  // Verify bigint values were serialized as decimal strings via scanJsonReplacer
  assert.equal(parsedLines[1].payload.stake, "25000000");
  assert.equal(parsedLines[2].payload.stake, "50000000");
  assert.equal(parsedLines[4].payload.totalPaid, "40000000");

  const summary = parsedLines[parsedLines.length - 1];
  assert.equal(summary.type, "summary");
  assert.equal(summary.eventCount, 6);
  assert.deepEqual(summary.histogram, {
    claim_challenged: 2,
    claim_created: 1,
    claim_resolved: 1,
    market_settled: 1,
    "unknown:?": 1,
  });
});

test("formatScanJsonl handles empty event array with a single valid summary line", () => {
  const output = formatScanJsonl([]);
  assert.equal(output.endsWith("\n"), true);

  const rawLines = output.trimEnd().split("\n");
  assert.equal(rawLines.length, 1);

  const summary = JSON.parse(rawLines[0]);
  assert.equal(summary.type, "summary");
  assert.equal(summary.eventCount, 0);
  assert.deepEqual(summary.histogram, {});
});

test("scanner CLI --jsonl writes only valid JSON lines to stdout and sends progress to stderr", async () => {
  const mock = await startMockRpc({ port: 0 });
  try {
    const env = { ...process.env, STELLAR_RPC_URL: mock.url };
    delete env.MIMIR_PROFILE;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [EVENTS_CLI, "--mock", "--jsonl", "--pages", "5"],
      { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );

    assert.ok(stderr.includes("scanning mock ledgers"), "progress must go to stderr");
    assert.ok(stderr.includes("scanned market:"), "target progress must go to stderr");

    const lines = stdout.trimEnd().split("\n");
    assert.ok(lines.length >= 2, "must emit event lines and final summary line");

    const parsed = lines.map((line) => JSON.parse(line));
    for (let i = 0; i < parsed.length - 1; i++) {
      assert.equal(parsed[i].type, "event");
      assert.ok(typeof parsed[i].ledger === "number");
      assert.ok(typeof parsed[i].payload?.name === "string");
    }

    const last = parsed[parsed.length - 1];
    assert.equal(last.type, "summary");
    assert.equal(last.eventCount, parsed.length - 1);
    assert.ok(last.histogram && typeof last.histogram === "object");
  } finally {
    await mock.close();
  }
});
