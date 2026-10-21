import test from "node:test"
import assert from "node:assert"

import { impliedOdds } from "../src/stellar/odds.js"

const cases = [
  {
    name: "equal pools, no fee",
    poolA: 1000n,
    poolB: 1000n,
    feeBps: 0n,
    expected: {
      ok: true,
      shareA: "50.00",
      shareB: "50.00",
      multiplierA: "2.0000",
      multiplierB: "2.0000",
    },
  },
  {
    name: "equal pools, typical fee",
    poolA: 1000n,
    poolB: 1000n,
    feeBps: 100n,
    expected: {
      ok: true,
      shareA: "50.00",
      shareB: "50.00",
      multiplierA: "1.9800",
      multiplierB: "1.9800",
    },
  },
  {
    name: "1:0 pools return no odds",
    poolA: 1000n,
    poolB: 0n,
    feeBps: 100n,
    expected: { ok: false },
  },
  {
    name: "0:1 pools return no odds",
    poolA: 0n,
    poolB: 1000n,
    feeBps: 100n,
    expected: { ok: false },
  },
  {
    name: "empty pools return no odds",
    poolA: 0n,
    poolB: 0n,
    feeBps: 0n,
    expected: { ok: false },
  },
  {
    name: "max fee of 10000 bps",
    poolA: 500n,
    poolB: 1500n,
    feeBps: 10000n,
    expected: {
      ok: true,
      shareA: "25.00",
      shareB: "75.00",
      multiplierA: "0.0000",
      multiplierB: "0.0000",
    },
  },
  {
    name: "very large pools near i128 range",
    poolA: 1n << 120n,
    poolB: 1n << 120n,
    feeBps: 10n,
    expected: {
      ok: true,
      shareA: "50.00",
      shareB: "50.00",
      multiplierA: "1.9990",
      multiplierB: "1.9990",
    },
  },
]

test("impliedOdds table cases", () => {
  for (const c of cases) {
    assert.deepStrictEqual(impliedOdds(c.poolA, c.poolB, c.feeBps), c.expected, c.name);
  }
})

test("impliedOdds is deterministic", () => {
  const a = impliedOdds(12345n, 67890n, 250n);
  const b = impliedOdds(12345n, 67890n, 250n);
  assert.deepStrictEqual(a, b);
})

test("impliedOdds rejects invalid fee", () => {
  assert.throws(() => impliedOdds(1n, 1n, 10001n), RangeError);
})
