/**
 * tests/bench-budget.test.mjs
 *
 * Performance budget regression test for `decodeEvent` (src/stellar/decode.ts)
 * and `formatEvent` (src/notifications/format.ts).
 *
 * ── CI Stability & Generous Budget Rationale ─────────────────────────────────
 *
 * Under normal conditions on modern hardware, decode + format of an event fixture
 * takes ~0.2 - 0.7 ms (>1,500 ops/sec).
 *
 * In shared CI environments (e.g. GitHub Actions runners running Node 20, Node 22,
 * or Node 24), CPU resources are shared and throttled, background processes cause
 * scheduling delays, and garbage collection can trigger sudden pauses.
 *
 * To ensure this test is 100% stable across Node 20, Node 22, and Node 24 runners
 * without flaking, we set generous budget thresholds:
 *   - MAX_ALLOWED_AVG_MS_PER_EVENT = 25.0 ms (>35x headroom over typical 0.5 ms)
 *   - MAX_ALLOWED_P95_MS_PER_EVENT = 50.0 ms (>25x headroom over typical 1.5 ms)
 *   - MIN_ALLOWED_OPS_PER_SEC      = 20.0 ops/sec (normal is >1,500 ops/sec)
 *
 * These thresholds are generous enough to never trip on CI runner jitter, yet tight
 * enough to immediately fail if an accidental synchronous network call, quadratic
 * algorithm, disk I/O, or regex catastrophic backtracking is introduced into the
 * hot per-event path.
 *
 * ── Iteration Count ──────────────────────────────────────────────────────────
 *
 * Runs a small iteration count (2 warmup iterations, 3 measured iterations of 100 events)
 * so that the test finishes in ~100-300 ms and does not prolong test runs or CI gates.
 *
 * ── Hermetic / Offline ───────────────────────────────────────────────────────
 *
 * Needs no live network connection and no environment variables.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  calculatePercentile,
  DEFAULT_BUDGET,
  runBenchmark,
} from "../scripts/bench-decode.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchScriptPath = path.resolve(here, "../scripts/bench-decode.mjs");

/**
 * Budget thresholds documented for CI stability across Node 20, 22, and 24.
 */
const MAX_ALLOWED_AVG_MS_PER_EVENT = DEFAULT_BUDGET.maxAvgPerEventMs; // 25.0 ms
const MAX_ALLOWED_P95_MS_PER_EVENT = DEFAULT_BUDGET.maxP95PerEventMs; // 50.0 ms
const MIN_ALLOWED_OPS_PER_SEC = DEFAULT_BUDGET.minOpsPerSec;          // 20 ops/sec

test("decode and format throughput stays within generous CI budget", () => {
  // Small iteration count for rapid, deterministic test execution
  const eventsCount = 100;
  const iterations = 3;
  const warmupIterations = 2;

  const summary = runBenchmark({
    eventsCount,
    iterations,
    warmupIterations,
  });

  // Verify structure and event counting
  assert.equal(summary.eventsPerIteration, eventsCount);
  assert.equal(summary.iterations, iterations);
  assert.equal(summary.warmupIterations, warmupIterations);
  assert.equal(summary.totalEvents, eventsCount * iterations);
  assert.equal(summary.iterationStats.length, iterations);

  // Assert against generous budget
  assert.ok(
    summary.avgPerEventMs <= MAX_ALLOWED_AVG_MS_PER_EVENT,
    `Average per-event time ${summary.avgPerEventMs} ms exceeded budget of ${MAX_ALLOWED_AVG_MS_PER_EVENT} ms`,
  );

  assert.ok(
    summary.p95PerEventMs <= MAX_ALLOWED_P95_MS_PER_EVENT,
    `p95 per-event time ${summary.p95PerEventMs} ms exceeded budget of ${MAX_ALLOWED_P95_MS_PER_EVENT} ms`,
  );

  assert.ok(
    summary.opsPerSec >= MIN_ALLOWED_OPS_PER_SEC,
    `Throughput ${summary.opsPerSec} ops/sec dropped below minimum ${MIN_ALLOWED_OPS_PER_SEC} ops/sec`,
  );

  // Sanity assertions on percentiles
  assert.ok(summary.minPerEventMs <= summary.p50PerEventMs, "min <= p50");
  assert.ok(summary.p50PerEventMs <= summary.p95PerEventMs, "p50 <= p95");
  assert.ok(summary.p95PerEventMs <= summary.p99PerEventMs, "p95 <= p99");
  assert.ok(summary.p99PerEventMs <= summary.maxPerEventMs, "p99 <= max");
});

test("scripts/bench-decode.mjs CLI runs offline and outputs valid JSON summary", () => {
  const stdout = execFileSync(
    process.execPath,
    [benchScriptPath, "--events=50", "--iterations=2", "--warmup=1"],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, NODE_ENV: "test" },
    },
  );

  const parsed = JSON.parse(stdout);

  assert.equal(parsed.eventsPerIteration, 50);
  assert.equal(parsed.iterations, 2);
  assert.equal(parsed.totalEvents, 100);
  assert.ok(Number.isFinite(parsed.opsPerSec) && parsed.opsPerSec > 0, "valid opsPerSec");
  assert.ok(Number.isFinite(parsed.p95PerEventMs) && parsed.p95PerEventMs > 0, "valid p95PerEventMs");
  assert.ok(Number.isFinite(parsed.avgPerEventMs) && parsed.avgPerEventMs > 0, "valid avgPerEventMs");
  assert.equal(parsed.iterationStats.length, 2);

  // CLI output must also satisfy the generous budget
  assert.ok(
    parsed.avgPerEventMs <= MAX_ALLOWED_AVG_MS_PER_EVENT,
    `CLI avg ${parsed.avgPerEventMs} ms exceeded budget of ${MAX_ALLOWED_AVG_MS_PER_EVENT} ms`,
  );
  assert.ok(
    parsed.p95PerEventMs <= MAX_ALLOWED_P95_MS_PER_EVENT,
    `CLI p95 ${parsed.p95PerEventMs} ms exceeded budget of ${MAX_ALLOWED_P95_MS_PER_EVENT} ms`,
  );
});

test("benchmark handles zero events gracefully", () => {
  const summary = runBenchmark({ eventsCount: 0, iterations: 1, warmupIterations: 0 });
  assert.equal(summary.totalEvents, 0);
  assert.equal(summary.opsPerSec, 0);
  assert.equal(summary.avgPerEventMs, 0);
  assert.equal(summary.p95PerEventMs, 0);
});

test("calculatePercentile helper computes percentiles accurately", () => {
  assert.equal(calculatePercentile([], 95), 0);
  assert.equal(calculatePercentile([10], 95), 10);
  assert.equal(calculatePercentile([10, 20], 50), 15);

  const dataset = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(calculatePercentile(dataset, 0), 1);
  assert.equal(calculatePercentile(dataset, 50), 5.5);
  assert.equal(calculatePercentile(dataset, 100), 10);
});
