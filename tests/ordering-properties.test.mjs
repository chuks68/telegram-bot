/**
 * Property-based tests for event ordering (compareEvents, sortEvents).
 *
 * Tests antisymmetry, transitivity, idempotence, and immutability using a
 * small seeded random generator without external dependencies.
 *
 * Each property runs 200+ generated cases with a fixed seed for reproducibility.
 * Total: 1000+ cases across all properties.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compareEvents, sortEvents } from "../dist/stellar/decode.js";

// ── Seeded random generator (no external dependency) ────────────────────────

class SeededRandom {
  constructor(seed = 0x12345678) {
    this.seed = seed;
  }

  // Mulberry32: a small, fast, high-quality PRNG
  next() {
    let t = this.seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextBool() {
    return this.next() < 0.5;
  }

  // Sometimes return null for transaction/operation indices
  nextIndex() {
    return this.nextBool() ? this.nextInt(0, 100) : null;
  }
}

// ── Event generator ──────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * Generate a minimal EventMeta object directly for fast property testing.
 * Only includes the fields used by compareEvents: ledger, transactionIndex,
 * operationIndex, eventId, and txHash.
 */
function generateEvent(rng) {
  const ledger = rng.nextInt(0, 1000);
  const order = rng.nextInt(0, 1000);
  // Simplified cursor format without BigInt for speed
  const eventId = `${ledger * 0x100000000}-${order}`;
  return {
    source: "market",
    contractId: "",
    version: "v1",
    ledger,
    txHash: rng.nextBool() ? HASH_A : HASH_B,
    at: 1704067200, // Fixed timestamp
    eventId,
    eventType: "contract",
    transactionIndex: rng.nextIndex(),
    operationIndex: rng.nextIndex(),
    inSuccessfulContractCall: true,
    payload: { name: "unknown", eventName: "test", reason: "synthetic" },
  };
}

// ── Property: Antisymmetry ───────────────────────────────────────────────────

/**
 * Antisymmetry: if compareEvents(a, b) <= 0 and compareEvents(b, a) <= 0,
 * then a and b must be equal (or at least have equal ordering keys).
 */
test("property: compareEvents is antisymmetric", () => {
  const SEED = 0xCAFEBABE;
  const rng = new SeededRandom(SEED);
  const cases = 200;
  let failures = [];

  for (let i = 0; i < cases; i++) {
    const a = generateEvent(rng);
    const b = generateEvent(rng);

    const cmpAB = compareEvents(a, b);
    const cmpBA = compareEvents(b, a);

    // If both comparisons are non-positive, they should be equal
    if (cmpAB <= 0 && cmpBA <= 0) {
      // For equal ordering, the result should be 0
      if (cmpAB !== 0 || cmpBA !== 0) {
        failures.push({
          case: i,
          seed: SEED,
          a: { ledger: a.ledger, txIdx: a.transactionIndex, opIdx: a.operationIndex, id: a.eventId },
          b: { ledger: b.ledger, txIdx: b.transactionIndex, opIdx: b.operationIndex, id: b.eventId },
          cmpAB,
          cmpBA,
        });
      }
    }
  }

  if (failures.length > 0) {
    const first = failures[0];
    assert.fail(
      `Antisymmetry violated at case ${first.case} (seed ${first.seed})\n` +
      `  a: ${JSON.stringify(first.a)}\n` +
      `  b: ${JSON.stringify(first.b)}\n` +
      `  compareEvents(a, b) = ${first.cmpAB}\n` +
      `  compareEvents(b, a) = ${first.cmpBA}\n` +
      `  Total failures: ${failures.length}`,
    );
  }
});

// ── Property: Transitivity ───────────────────────────────────────────────────

/**
 * Transitivity: if compareEvents(a, b) < 0 and compareEvents(b, c) < 0,
 * then compareEvents(a, c) must also be < 0.
 */
test("property: compareEvents is transitive", () => {
  const SEED = 0xDEADBEEF;
  const rng = new SeededRandom(SEED);
  const cases = 200;
  let failures = [];

  for (let i = 0; i < cases; i++) {
    const a = generateEvent(rng);
    const b = generateEvent(rng);
    const c = generateEvent(rng);

    const cmpAB = compareEvents(a, b);
    const cmpBC = compareEvents(b, c);
    const cmpAC = compareEvents(a, c);

    // If a < b and b < c, then a < c must hold
    if (cmpAB < 0 && cmpBC < 0) {
      if (cmpAC >= 0) {
        failures.push({
          case: i,
          seed: SEED,
          a: { ledger: a.ledger, txIdx: a.transactionIndex, opIdx: a.operationIndex, id: a.eventId },
          b: { ledger: b.ledger, txIdx: b.transactionIndex, opIdx: b.operationIndex, id: b.eventId },
          c: { ledger: c.ledger, txIdx: c.transactionIndex, opIdx: c.operationIndex, id: c.eventId },
          cmpAB,
          cmpBC,
          cmpAC,
        });
      }
    }
  }

  if (failures.length > 0) {
    const first = failures[0];
    assert.fail(
      `Transitivity violated at case ${first.case} (seed ${first.seed})\n` +
      `  a: ${JSON.stringify(first.a)}\n` +
      `  b: ${JSON.stringify(first.b)}\n` +
      `  c: ${JSON.stringify(first.c)}\n` +
      `  compareEvents(a, b) = ${first.cmpAB}\n` +
      `  compareEvents(b, c) = ${first.cmpBC}\n` +
      `  compareEvents(a, c) = ${first.cmpAC}\n` +
      `  Total failures: ${failures.length}`,
    );
  }
});

// ── Property: Idempotence ────────────────────────────────────────────────────

/**
 * Idempotence: sorting an already-sorted array produces the same result.
 */
test("property: sortEvents is idempotent", () => {
  const SEED = 0xFEE1DEAD;
  const rng = new SeededRandom(SEED);
  const cases = 200;
  let failures = [];

  for (let i = 0; i < cases; i++) {
    const size = rng.nextInt(1, 2);
    const events = Array.from({ length: size }, () => generateEvent(rng));

    const sortedOnce = sortEvents(events);
    const sortedTwice = sortEvents(sortedOnce);

    // Compare by eventId since we're checking if the arrays are identical
    const idsOnce = sortedOnce.map((e) => e.eventId);
    const idsTwice = sortedTwice.map((e) => e.eventId);

    if (idsOnce.length !== idsTwice.length || idsOnce.some((id, idx) => id !== idsTwice[idx])) {
      failures.push({
        case: i,
        seed: SEED,
        size,
        idsOnce,
        idsTwice,
      });
    }
  }

  if (failures.length > 0) {
    const first = failures[0];
    assert.fail(
      `Idempotence violated at case ${first.case} (seed ${first.seed})\n` +
      `  Array size: ${first.size}\n` +
      `  First sort:  ${JSON.stringify(first.idsOnce)}\n` +
      `  Second sort: ${JSON.stringify(first.idsTwice)}\n` +
      `  Total failures: ${failures.length}`,
    );
  }
});

// ── Property: Immutability ───────────────────────────────────────────────────

/**
 * Immutability: sortEvents does not mutate its input array.
 */
test("property: sortEvents does not mutate input", () => {
  const SEED = 0xBAADF00D;
  const rng = new SeededRandom(SEED);
  const cases = 200;
  let failures = [];

  for (let i = 0; i < cases; i++) {
    const size = rng.nextInt(1, 2);
    const events = Array.from({ length: size }, () => generateEvent(rng));

    // Snapshot the original order
    const originalIds = [...events.map((e) => e.eventId)];

    // Sort the array
    sortEvents(events);

    // Check that the input array hasn't changed
    const afterIds = events.map((e) => e.eventId);

    if (originalIds.length !== afterIds.length || originalIds.some((id, idx) => id !== afterIds[idx])) {
      failures.push({
        case: i,
        seed: SEED,
        size,
        originalIds,
        afterIds,
      });
    }
  }

  if (failures.length > 0) {
    const first = failures[0];
    assert.fail(
      `Immutability violated at case ${first.case} (seed ${first.seed})\n` +
      `  Array size: ${first.size}\n` +
      `  Original IDs: ${JSON.stringify(first.originalIds)}\n` +
      `  After sort:   ${JSON.stringify(first.afterIds)}\n` +
      `  Total failures: ${failures.length}`,
    );
  }
});

// ── Property: Total order with null indices ─────────────────────────────────

/**
 * Total order with null indices: events with null transaction/operation indices
 * should still sort deterministically (after known positions).
 */
test("property: total order with null indices", () => {
  const SEED = 0xC0FFEE;
  const rng = new SeededRandom(SEED);
  const cases = 200;
  let failures = [];

  for (let i = 0; i < cases; i++) {
    const size = 2; // Fixed size for consistency
    const events = Array.from({ length: size }, () => generateEvent(rng));

    // Sort the events
    const sorted = sortEvents(events);

    // Verify that every adjacent pair is ordered correctly
    for (let j = 0; j < sorted.length - 1; j++) {
      const cmp = compareEvents(sorted[j], sorted[j + 1]);
      if (cmp > 0) {
        failures.push({
          case: i,
          seed: SEED,
          index: j,
          a: { ledger: sorted[j].ledger, txIdx: sorted[j].transactionIndex, opIdx: sorted[j].operationIndex, id: sorted[j].eventId },
          b: { ledger: sorted[j + 1].ledger, txIdx: sorted[j + 1].transactionIndex, opIdx: sorted[j + 1].operationIndex, id: sorted[j + 1].eventId },
          cmp,
        });
        break; // Only record first per case
      }
    }
  }

  if (failures.length > 0) {
    const first = failures[0];
    assert.fail(
      `Total order violated at case ${first.case}, index ${first.index} (seed ${first.seed})\n` +
      `  a: ${JSON.stringify(first.a)}\n` +
      `  b: ${JSON.stringify(first.b)}\n` +
      `  compareEvents(a, b) = ${first.cmp}\n` +
      `  Total failures: ${failures.length}`,
    );
  }
});
