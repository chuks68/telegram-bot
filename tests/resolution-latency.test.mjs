import assert from "node:assert/strict";
import test from "node:test";

import { resolutionLatency } from "../dist/stellar/resolution-latency.js";

function mockEvent({ name, claimId, ledger, at, contractId = "C1", txHash = "hash" }) {
  return {
    source: "market",
    contractId,
    version: "v1",
    ledger,
    txHash,
    at,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId,
      ...(name === "claim_created"
        ? { creator: "G1", category: "crypto", title: "Test claim" }
        : name === "claim_resolved"
        ? { winnerSide: 1, summary: "Resolved test", confidence: 100, evidenceHash: "00" }
        : {}),
    },
  };
}

test("resolutionLatency: handles resolved claims with duration and summary stats", () => {
  // Claim 1: creation at 1000, ledger 10; resolved at 1060, ledger 20 (dur: 60s, 10 ledgers)
  // Claim 2: creation at 1000, ledger 10; resolved at 1120, ledger 30 (dur: 120s, 20 ledgers)
  const events = [
    mockEvent({ name: "claim_created", claimId: 1, ledger: 10, at: 1000 }),
    mockEvent({ name: "claim_created", claimId: 2, ledger: 10, at: 1000 }),
    mockEvent({ name: "claim_resolved", claimId: 1, ledger: 20, at: 1060 }),
    mockEvent({ name: "claim_resolved", claimId: 2, ledger: 30, at: 1120 }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.excludedCount, 0);
  assert.equal(report.resolved.claims.length, 2);
  assert.equal(report.cancelled.claims.length, 0);

  const c1 = report.resolved.claims[0];
  assert.equal(c1.claimId, 1);
  assert.equal(c1.creationLedger, 10);
  assert.equal(c1.creationAt, 1000);
  assert.equal(c1.resolutionLedger, 20);
  assert.equal(c1.resolutionAt, 1060);
  assert.deepEqual(c1.duration, { seconds: 60, ledgers: 10 });

  const c2 = report.resolved.claims[1];
  assert.equal(c2.claimId, 2);
  assert.deepEqual(c2.duration, { seconds: 120, ledgers: 20 });

  assert.ok(report.resolved.summary);
  assert.deepEqual(report.resolved.summary.p50, { seconds: 60, ledgers: 10 });
  assert.deepEqual(report.resolved.summary.p90, { seconds: 120, ledgers: 20 });
  assert.deepEqual(report.resolved.summary.max, { seconds: 120, ledgers: 20 });
});

test("resolutionLatency: cancelled claims are reported separately", () => {
  const events = [
    mockEvent({ name: "claim_created", claimId: 10, ledger: 100, at: 2000 }),
    mockEvent({ name: "claim_cancelled", claimId: 10, ledger: 115, at: 2075 }),
    mockEvent({ name: "claim_created", claimId: 20, ledger: 100, at: 2000 }),
    mockEvent({ name: "claim_resolved", claimId: 20, ledger: 130, at: 2150 }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.excludedCount, 0);
  assert.equal(report.resolved.claims.length, 1);
  assert.equal(report.cancelled.claims.length, 1);

  assert.equal(report.cancelled.claims[0].claimId, 10);
  assert.deepEqual(report.cancelled.claims[0].duration, { seconds: 75, ledgers: 15 });

  assert.equal(report.resolved.claims[0].claimId, 20);
  assert.deepEqual(report.resolved.claims[0].duration, { seconds: 150, ledgers: 30 });
});

test("resolutionLatency: excludes incomplete claims missing either end and counts them", () => {
  const events = [
    // Claim 1: Only created (missing resolution/cancellation)
    mockEvent({ name: "claim_created", claimId: 1, ledger: 50, at: 500 }),
    // Claim 2: Only resolved (missing creation)
    mockEvent({ name: "claim_resolved", claimId: 2, ledger: 60, at: 600 }),
    // Claim 3: Only cancelled (missing creation)
    mockEvent({ name: "claim_cancelled", claimId: 3, ledger: 70, at: 700 }),
    // Claim 4: Complete resolved
    mockEvent({ name: "claim_created", claimId: 4, ledger: 50, at: 500 }),
    mockEvent({ name: "claim_resolved", claimId: 4, ledger: 55, at: 525 }),
  ];

  const report = resolutionLatency(events);

  // 3 claims are missing either creation or resolution/cancellation
  assert.equal(report.excludedCount, 3);
  assert.equal(report.resolved.claims.length, 1);
  assert.equal(report.resolved.claims[0].claimId, 4);
  assert.equal(report.cancelled.claims.length, 0);
});

test("resolutionLatency: empty input returns empty groups and zero exclusions", () => {
  const report = resolutionLatency([]);

  assert.equal(report.excludedCount, 0);
  assert.equal(report.resolved.claims.length, 0);
  assert.equal(report.resolved.summary, null);
  assert.equal(report.cancelled.claims.length, 0);
  assert.equal(report.cancelled.summary, null);
});

test("resolutionLatency: deterministic output regardless of input event order", () => {
  const events = [
    mockEvent({ name: "claim_resolved", claimId: 2, ledger: 200, at: 2000 }),
    mockEvent({ name: "claim_created", claimId: 1, ledger: 100, at: 1000 }),
    mockEvent({ name: "claim_cancelled", claimId: 3, ledger: 150, at: 1500 }),
    mockEvent({ name: "claim_created", claimId: 2, ledger: 100, at: 1000 }),
    mockEvent({ name: "claim_created", claimId: 3, ledger: 100, at: 1000 }),
    mockEvent({ name: "claim_resolved", claimId: 1, ledger: 300, at: 3000 }),
  ];

  const shuffledEvents = [...events].reverse();

  const report1 = resolutionLatency(events);
  const report2 = resolutionLatency(shuffledEvents);

  assert.deepEqual(report1, report2);
  assert.equal(report1.resolved.claims[0].claimId, 1);
  assert.equal(report1.resolved.claims[1].claimId, 2);
  assert.equal(report1.cancelled.claims[0].claimId, 3);
});

test("resolutionLatency: computes percentiles deterministically with multiple data points", () => {
  const events = [];
  // 10 claims: durations 10s, 20s, ..., 100s
  for (let i = 1; i <= 10; i++) {
    events.push(mockEvent({ name: "claim_created", claimId: i, ledger: 10, at: 1000 }));
    events.push(mockEvent({ name: "claim_resolved", claimId: i, ledger: 10 + i, at: 1000 + i * 10 }));
  }

  const report = resolutionLatency(events);
  assert.equal(report.resolved.claims.length, 10);
  // Sorted durations: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  // p50: ceil(50/100 * 10) = 5 -> index 4 -> 50
  // p90: ceil(90/100 * 10) = 9 -> index 8 -> 90
  // max: 100
  assert.deepEqual(report.resolved.summary.p50, { seconds: 50, ledgers: 5 });
  assert.deepEqual(report.resolved.summary.p90, { seconds: 90, ledgers: 9 });
  assert.deepEqual(report.resolved.summary.max, { seconds: 100, ledgers: 10 });
});
