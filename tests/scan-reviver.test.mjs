/**
 * Tests for scan-reviver: round-trip JSON serialization/deserialization with bigint restoration.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodeEvent, dedupeEvents, sortEvents } from "../dist/stellar/decode.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  formatScanJson,
  scanJsonReplacer,
} from "../dist/stellar/events.js";
import { reviveScanReport, ScanReviverError } from "../dist/stellar/scan-reviver.js";

import {
  claimChallengedEvent,
  claimCreatedEvent,
  claimResolvedEvent,
  claimCancelledEvent,
  marketSettledEvent,
  challengerPaidEvent,
  feeClaimedEvent,
  withdrawalEvent,
  withdrawalPendingEvent,
  squadMarketCreatedEvent,
  squadDepositedEvent,
  squadWithdrawnEvent,
  squadResolvedEvent,
  squadClaimedEvent,
  squadFeesClaimedEvent,
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  CREATOR,
} from "./fixtures/events.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  network: "Test SDF Network ; September 2015",
  rpcUrl: "https://rpc.testnet.stellar.org",
};

/**
 * Decode a fixture event and wrap it in a ContractScan structure.
 */
function fixtureToScan(source, fixture) {
  const decoded = decodeEvent(source, fixture);
  return {
    source,
    contractId: source === "market" ? MARKET_CONTRACT : SQUAD_CONTRACT,
    version: "v1",
    events: sortEvents(dedupeEvents([decoded])),
    cursor: "0018276211125911551-4294967295",
    latestLedger: 4226691,
    oldestLedger: 4220000,
    truncated: false,
    pages: 1,
    emptyPages: 0,
    duplicates: 0,
    seenEventIds: [],
    startLedger: 4220000,
    startClamped: false,
    timing: { health: { count: 1, totalMs: 100 }, events: { count: 1, totalMs: 50 } },
    lastEventLedger: 4226691,
  };
}

// ── Round-trip tests for each event type ─────────────────────────────────────

test("round-trip: claim_created (no bigint fields)", () => {
  const scan = fixtureToScan("market", claimCreatedEvent());
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
});

test("round-trip: claim_challenged (stake: bigint)", () => {
  const scan = fixtureToScan("market", claimChallengedEvent({ stake: 20_000_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.stake, "bigint");
});

test("round-trip: claim_resolved (no bigint fields)", () => {
  const scan = fixtureToScan("market", claimResolvedEvent());
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
});

test("round-trip: claim_cancelled (no bigint fields)", () => {
  const scan = fixtureToScan("market", claimCancelledEvent());
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
});

test("round-trip: market_settled (multiple bigint fields)", () => {
  const scan = fixtureToScan("market", marketSettledEvent({
    totalPaid: 40_000_000n,
    totalFees: 2_000_000n,
    owedToChallengers: 38_000_000n,
    dust: 0n,
  }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.totalPaid, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.totalFees, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.owedToChallengers, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.dust, "bigint");
});

test("round-trip: challenger_paid (multiple bigint fields)", () => {
  const scan = fixtureToScan("market", challengerPaidEvent({
    stake: 20_000_000n,
    gross: 38_000_000n,
    fee: 1_900_000n,
    net: 36_100_000n,
  }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.stake, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.gross, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.fee, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.net, "bigint");
});

test("round-trip: fee_claimed (amount: bigint)", () => {
  const scan = fixtureToScan("market", feeClaimedEvent({ amount: 2_000_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
});

test("round-trip: withdrawal (amount: bigint)", () => {
  const scan = fixtureToScan("market", withdrawalEvent({ amount: 10_000_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
});

test("round-trip: withdrawal_pending (amount: bigint)", () => {
  const scan = fixtureToScan("market", withdrawalPendingEvent({ amount: 10_000_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
});

test("round-trip: squad market_created (no bigint fields)", () => {
  const scan = fixtureToScan("squad", squadMarketCreatedEvent());
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
});

test("round-trip: squad deposited (amount, shares: bigint)", () => {
  const scan = fixtureToScan("squad", squadDepositedEvent({
    amount: 50_000_000n,
    shares: 50_000_000n,
  }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.shares, "bigint");
});

test("round-trip: squad withdrawn (amount: bigint)", () => {
  const scan = fixtureToScan("squad", squadWithdrawnEvent({ amount: 50_000_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
});

test("round-trip: squad resolved (poolA, poolB: bigint)", () => {
  const scan = fixtureToScan("squad", squadResolvedEvent({
    poolA: 50_000_000n,
    poolB: 30_000_000n,
  }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.poolA, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.poolB, "bigint");
});

test("round-trip: squad claimed (gross, fee, net: bigint)", () => {
  const scan = fixtureToScan("squad", squadClaimedEvent({
    gross: 80_000_000n,
    fee: 1_600_000n,
    net: 78_400_000n,
  }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.gross, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.fee, "bigint");
  assert.strictEqual(typeof revived.targets[0].events[0].payload.net, "bigint");
});

test("round-trip: squad fees_claimed (amount: bigint)", () => {
  const scan = fixtureToScan("squad", squadFeesClaimedEvent({ amount: 3_600_000n }));
  const target = buildScanJsonTarget(scan, 1);
  const report = buildScanJsonReport({
    ...MOCK_CONFIG,
    oldestLedger: 4220000,
    latestLedger: 4226691,
    targets: [target],
  });

  const json = formatScanJson(report);
  const revived = reviveScanReport(json);

  assert.deepEqual(revived, report);
  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
});

// ── Error handling ───────────────────────────────────────────────────────────

test("rejects malformed JSON", () => {
  assert.throws(
    () => reviveScanReport("{invalid json"),
    ScanReviverError,
    "malformed JSON",
  );
});

test("rejects non-object JSON", () => {
  assert.throws(
    () => reviveScanReport("[]"),
    ScanReviverError,
    "JSON is not an object",
  );
});

test("rejects unknown format version", () => {
  const report = {
    format: "mimir-scan-v2",
    network: "test",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
    targets: [],
  };
  assert.throws(
    () => reviveScanReport(JSON.stringify(report)),
    ScanReviverError,
    'unknown format: expected "mimir-scan-v1"',
  );
});

test("rejects missing network field", () => {
  const report = {
    format: "mimir-scan-v1",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
    targets: [],
  };
  assert.throws(
    () => reviveScanReport(JSON.stringify(report)),
    ScanReviverError,
    "missing or invalid 'network' field",
  );
});

test("rejects missing rpcUrl field", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    ledgers: { oldest: 1, latest: 100 },
    targets: [],
  };
  assert.throws(
    () => reviveScanReport(JSON.stringify(report)),
    ScanReviverError,
    "missing or invalid 'rpcUrl' field",
  );
});

test("rejects missing ledgers field", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    rpcUrl: "https://example.com",
    targets: [],
  };
  assert.throws(
    () => reviveScanReport(JSON.stringify(report)),
    ScanReviverError,
    "missing or invalid 'ledgers' field",
  );
});

test("rejects missing targets field", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
  };
  assert.throws(
    () => reviveScanReport(JSON.stringify(report)),
    ScanReviverError,
    "missing or invalid 'targets' field",
  );
});

// ── Unknown events ───────────────────────────────────────────────────────────

test("unknown event fields remain as strings", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        pages: 1,
        eventCount: 1,
        truncated: false,
        lastEventLedger: 100,
        cursor: "test",
        startLedger: 1,
        startClamped: false,
        histogram: { unknown_event: 1 },
        events: [
          {
            ledger: 100,
            txHash: "a".repeat(64),
            eventId: "test",
            summary: "test",
            payload: {
              name: "unknown_future_event",
              customAmount: "5000000", // Should remain string
              customField: "value",
            },
          },
        ],
      },
    ],
  };

  const json = JSON.stringify(report, scanJsonReplacer, 2);
  const revived = reviveScanReport(json);

  assert.strictEqual(typeof revived.targets[0].events[0].payload.customAmount, "string");
  assert.strictEqual(revived.targets[0].events[0].payload.customAmount, "5000000");
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("handles negative bigint values", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        pages: 1,
        eventCount: 1,
        truncated: false,
        lastEventLedger: 100,
        cursor: "test",
        startLedger: 1,
        startClamped: false,
        histogram: { withdrawal: 1 },
        events: [
          {
            ledger: 100,
            txHash: "a".repeat(64),
            eventId: "test",
            summary: "test",
            payload: {
              name: "withdrawal",
              to: CREATOR,
              amount: "-1000000", // Negative amount as string
            },
          },
        ],
      },
    ],
  };

  const json = JSON.stringify(report, scanJsonReplacer, 2);
  const revived = reviveScanReport(json);

  assert.strictEqual(typeof revived.targets[0].events[0].payload.amount, "bigint");
  assert.strictEqual(revived.targets[0].events[0].payload.amount, -1_000_000n);
});

test("handles zero bigint values", () => {
  const report = {
    format: "mimir-scan-v1",
    network: "test",
    rpcUrl: "https://example.com",
    ledgers: { oldest: 1, latest: 100 },
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        pages: 1,
        eventCount: 1,
        truncated: false,
        lastEventLedger: 100,
        cursor: "test",
        startLedger: 1,
        startClamped: false,
        histogram: { market_settled: 1 },
        events: [
          {
            ledger: 100,
            txHash: "a".repeat(64),
            eventId: "test",
            summary: "test",
            payload: {
              name: "market_settled",
              claimId: 1,
              totalPaid: "0",
              totalFees: "0",
              owedToChallengers: "0",
              dust: "0",
            },
          },
        ],
      },
    ],
  };

  const json = JSON.stringify(report, scanJsonReplacer, 2);
  const revived = reviveScanReport(json);

  assert.strictEqual(typeof revived.targets[0].events[0].payload.totalPaid, "bigint");
  assert.strictEqual(revived.targets[0].events[0].payload.totalPaid, 0n);
});
