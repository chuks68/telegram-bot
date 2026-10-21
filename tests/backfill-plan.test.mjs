import test from "node:test";
import assert from "node:assert";

import {
  planBackfill,
  describePlan,
  BackfillPlanError,
} from "../src/stellar/backfill-plan.ts";

function coveredCount(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.count, 0);
}

function assertContiguousAndNonOverlapping(chunks) {
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const cur = chunks[i];
    assert.strictEqual(
      cur.from,
      prev.to + 1,
      `hunk ${i} must start immediately after chunk ${i - 1}`,
    );
  }
}

test("planBackfill covers the reachable range exactly", () => {
  const plan = planBackfill({ from: 100, to: 250, oldest: 50, latest: 300, maxSpan: 40 });

  assert.deepStrictEqual(plan.reachable, { from: 100, to: 250 });
  assert.deepStrictEqual(plan.unreachable, []);
  assertContiguousAndNonOverlapping(plan.chunks);
  assert.strictEqual(coveredCount(plan.chunks), 250 - 100 + 1);
  assert.strictEqual(plan.chunks[0].from, 100);
  assert.strictEqual(plan.chunks[plan.chunks.length - 1].to, 250);
  for (const chunk of plan.chunks) {
    assert.ok(chunk.count <= 40);
  }
});

test("planBackfill flags ranges older than oldest as unreachable", () => {
  const plan = planBackfill({ from: 10, to: 100, oldest: 50, latest: 200, maxSpan: 20 });

  assert.deepStrictEqual(plan.reachable, { from: 50, to: 100 });
  assert.strictEqual(plan.unreachable.length, 1);
  assert.deepStrictEqual(plan.unreachable[0], {
    from: 10,
    to: 49,
    count: 40,
    reason: plan.unreachable[0].reason,
  });
  assertContiguousAndNonOverlapping(plan.chunks);
  assert.strictEqual(coveredCount(plan.chunks), 100 - 50 + 1);
  assert.strictEqual(plan.chunks[0].from, 50);
});

test("planBackfill clamps the upper bound to latest", () => {
  const plan = planBackfill({ from: 100, to: 500, oldest: 50, latest: 200, maxSpan: 50 });

  assert.deepStrictEqual(plan.reachable, { from: 100, to: 200 });
  assert.strictEqual(coveredCount(plan.chunks), 101);
  assert.strictEqual(plan.chunks[plan.chunks.length - 1].to, 200);
  assertContiguousAndNonOverlapping(plan.chunks);
});

test("planBackfill returns no chunks when the range is entirely unreachable", () => {
  const plan = planBackfill({ from: 10, to: 40, oldest: 50, latest: 200, maxSpan: 20 });

  assert.strictEqual(plan.reachable, null);
  assert.deepStrictEqual(plan.chunks, []);
  assert.strictEqual(plan.unreachable.length, 1);
  assert.strictEqual(plan.unreachable[0].from, 10);
  assert.strictEqual(plan.unreachable[0].to, 40);
});

test("planBackfill produces a single chunk when the range fits in maxSpan", () => {
  const plan = planBackfill({ from: 100, to: 105, oldest: 50, latest: 200, maxSpan: 100 });

  assert.deepStrictEqual(plan.chunks, [{ from: 100, to: 105, count: 6 }]);
});

test("planBackfill respects maxSpan of 1", () => {
  const plan = planBackfill({ from: 1, to: 5, oldest: 0, latest: 10, maxSpan: 1 });

  assert.strictEqual(plan.chunks.length, 5);
  for (const chunk of plan.chunks) {
    assert.strictEqual(chunk.count, 1);
  }
  assertContiguousAndNonOverlapping(plan.chunks);
});

test("planBackfill throws a typed error for from > to", () => {
  assert.throws(
    () => planBackfill({ from: 10, to: 5, oldest: 0, latest: 100, maxSpan: 10 }),
    (err) => {
      assert.ok(err instanceof BackfillPlanError);
      assert.strictEqual(err.code, "INVALID_RANGE");
      return true;
    },
  );
});

test("planBackfill throws a typed error for negative input", () => {
  assert.throws(
    () => planBackfill({ from: -1, to: 10, oldest: 0, latest: 100, maxSpan: 10 }),
    (err) => {
      assert.ok(err instanceof BackfillPlanError);
      assert.strictEqual(err.code, "INVALID_RANGE");
      return true;
    },
  );
  assert.throws(
    () => planBackfill({ from: 0, to: 10, oldest: -5, latest: 100, maxSpan: 10 }),
    (err) => {
      assert.ok(err instanceof BackfillPlanError);
      assert.strictEqual(err.code, "INVALID_BOUNDS");
      return true;
    },
  );
});

test("planBackfill throws a typed error for invalid maxSpan", () => {
  for (const maxSpan of [0, -1, 1.5, NaN]) {
    assert.throws(
      () => planBackfill({ from: 0, to: 10, oldest: 0, latest: 100, maxSpan: maxSpan }),
      (err) => {
        assert.ok(err instanceof BackfillPlanError);
        assert.strictEqual(err.code, "INVALID_MAX_SPAN");
        return true;
      },
    );
  }
});

test("planBackfill handles a single-ledger range", () => {
  const plan = planBackfill({ from: 7, to: 7, oldest: 0, latest: 10, maxSpan: 10 });

  assert.deepStrictEqual(plan.chunks, [{ from: 7, to: 7, count: 1 }]);
});

test("describePlan summarizes chunks and unreachable ranges", () => {
  const plan = planBackfill({ from: 10, to: 100, oldest: 50, latest: 200, maxSpan: 20 });
  const text = describePlan(plan);

  assert.match(text, /Backfill plan for ledgers 10\.\.100/);
  assert.match(text, /reachable: 50\.\.100/);
  assert.match(text, /unreachable:/);
  assert.match(text, /10\.\.49/);
});

// Property-style checks: randomized inputs still produce contiguous,
// non-overlapping chunks that cover exactly the reachable range.
test("planBackfill property: coverage and contiguity", () => {
  for (let i = 0; i < 200; i++) {
    const from = Math.floor(Math.random() * 1000);
    const to = from + Math.floor(Math.random() * 1000);
    const oldest = Math.floor(Math.random() * 1000);
    const latest = oldest + Math.floor(Math.random() * 1000);
    const maxSpan = 1 + Math.floor(Math.random() * 50);

    const plan = planBackfill({ from, to, oldest, latest, maxSpan });

    assertContiguousAndNonOverlapping(plan.chunks);

    const reachableFrom = Math.max(from, oldest);
    const reachableTo = Math.min(to, latest);

    if (reachableFrom > reachableTo) {
      assert.strictEqual(plan.reachable, null);
      assert.deepStrictEqual(plan.chunks, []);
    } else {
      assert.deepStrictEqual(plan.reachable, { from: reachableFrom, to: reachableTo });
      assert.strictEqual(plan.chunks[0].from, reachableFrom);
      assert.strictEqual(
        plan.chunks[plan.chunks.length - 1].to,
        reachableTo,
      );
      assert.strictEqual(
        coveredCount(plan.chunks),
        reachableTo - reachableFrom + 1,
      );
    }

    // Unreachable ranges must not overlap the reachable range.
    for (const range of plan.unreachable) {
      assert.ok(range.to < oldest);
    }
  }
});
