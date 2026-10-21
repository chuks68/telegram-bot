import assert from "node:assert/strict";
import test from "node:test";

import { createLagTracker } from "../dist/notifications/lag.js";

const BUCKETS = [100, 500, 1000, 5000, 10000];

test("createLagTracker: empty snapshot is null-percentile and JSON-serialisable (boundary)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  const snap = tracker.snapshot();
  assert.deepEqual(snap, { count: 0, skewed: 0, p50: null, p95: null, max: null });
  // JSON round-trip must preserve the shape.
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test("createLagTracker: computes lag from seconds to milliseconds (positive)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  // Event closed at 1700000000 seconds, sent 250 ms later.
  tracker.observe(1700000000, 1700000000 * 1000 + 250);
  const snap = tracker.snapshot();
  assert.equal(snap.count, 1);
  assert.equal(snap.skewed, 0);
  assert.equal(snap.max, 250);
  // 250 ms falls into the 500 ms bucket.
  assert.equal(snap.p50, 500);
  assert.equal(snap.p95, 500);
});

test("createLagTracker: negative lag is ignored but counted as skew (negative)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  // Sent 500 ms before the event time.
  tracker.observe(1700000000, 1700000000 * 1000 - 500);
  const snap = tracker.snapshot();
  assert.equal(snap.count, 0);
  assert.equal(snap.skewed, 1);
  assert.equal(snap.p50, null);
  assert.equal(snap.p95, null);
  assert.equal(snap.max, null);
});

test("createLagTracker: mixed skew and real lags stay separate (boundary)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  const base = 1700000000;
  tracker.observe(base, base * 1000 + 100); // 100 ms -> 100 bucket
  tracker.observe(base, base * 1000 - 100); // skew
  tracker.observe(base, base * 1000 + 10000); // 10000 ms -> 10000 bucket
  const snap = tracker.snapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.skewed, 1);
  assert.equal(snap.max, 10000);
});

test("createLagTracker: percentiles come from bounded buckets (positive)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  const base = 1700000000;
  // 100 observations spread across buckets: 50 at 50 ms, 40 at 300 ms, 10 at 2000 ms.
  for (let i = 0; i < 50; i++) {
    tracker.observe(base, base * 1000 + 50);
  }
  for (let i = 0; i < 40; i++) {
    tracker.observe(base, base * 1000 + 300);
  }
  for (let i = 0; i < 10; i++) {
    tracker.observe(base, base * 1000 + 2000);
  }
  const snap = tracker.snapshot();
  assert.equal(snap.count, 100);
  // Rank 50 of 100 -> 500ms bucket (50 at 50ms fits in 100ms bucket, but
  // the 500th cumulative observation is the 100th at 50ms, so p50 lands
  // in the 100ms bucket).
  assert.equal(snap.p50, 100);
  // Rank 95 of 100 -> 95th cumulative is the 90th at 300ms, so p95 lands
  // in the 500ms bucket.
  assert.equal(snap.p95, 500);
  assert.equal(snap.max, 2000);
});

test("createLagTracker: overflow bucket reports max for high percentiles (boundary)", () => {
  const tracker = createLagTracker({ buckets: [100, 500] });
  const base = 1700000000;
  tracker.observe(base, base * 1000 + 50000); // way above last bound
  const snap = tracker.snapshot();
  assert.equal(snap.count, 1);
  assert.equal(snap.p50, 50000); // +Inf bucket -> max
  assert.equal(snap.p95, 50000);
  assert.equal(snap.max, 50000);
});

test("createLagTracker: snapshot is JSON-serialisable (regression)", () => {
  const tracker = createLagTracker({ buckets: BUCKETS });
  const base = 1700000000;
  tracker.observe(base, base * 1000 + 123);
  tracker.observe(base, base * 1000 - 123);
  const snap = tracker.snapshot();
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap);
  for (const v of Object.values(snap)) {
    assert(
      v === null || typeof v === "number",
      `snapshot values must be number or null, got ${typeof v}`,
    );
  }
});

test("createLagTracker: renderPrometheus emits histogram lines (positive)", () => {
  const tracker = createLagTracker({ buckets: [100, 500] });
  const base = 1700000000;
  tracker.observe(base, base * 1000 + 50);
  tracker.observe(base, base * 1000 + 400);
  tracker.observe(base, base * 1000 - 10); // skew
  const text = tracker.renderPrometheus("notification_lag", "Delivery lag in ms");
  assert.match(text, /# HELP notification_lag Delivery lag in ms/);
  assert.match(text, /# TYPE notification_lag histogram/);
  assert.match(text, /notification_lag_bucket{le="100"} 1/);
  assert.match(text, /notification_lag_bucket{le="500"} 2/);
  assert.match(text, /notification_lag_bucket{le="\+Inf"} 2/);
  assert.match(text, /notification_lag_count 2/);
  assert.match(text, /notification_lag_skewed_total 1/);
});

test("createLagTracker: identical input is stable across instances (restart)", () => {
  const base = 1700000000;
  const a = createLagTracker({ buckets: BUCKETS });
  const b = createLagTracker({ buckets: BUCKETS });
  for (const t of [a, b]) {
    t.observe(base, base * 1000 + 150);
    t.observe(base, base * 1000 + 600);
  }
  assert.deepEqual(a.snapshot(), b.snapshot());
});
