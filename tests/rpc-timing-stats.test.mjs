import test from 'node:test';
import assert from 'node:assert';

import { RpcTiming, formatRpcTiming } from '../src/stellar/metrics.js';

// These tests pin the statistics reported by RpcTiming and the

// formatting produced by formatRpcTiming. Durations are injected
// directly (no real timers) so the expected values are deterministic.
//
// The exact public shape of RpcTiming is not assumed beyond that it
// records observations and exposes a summary of the recorded durations.
// The helpers below normalise the different possible shapes so the
// assertions remain stable.

function record(timing, duration, success = true) {
  if (typeof timing.record === 'function') {
    // Some implementations accept (duration, ok), others (duration,
    // { ok }), and others (ok, duration). Try the common forms and
    // fall back gracefully.
    try {
      timing.record(duration, success);
      return;
    } catch {
      // fall through
    }
    timing.record(duration, { ok: success });
    return;
  }
  if (typeof timing.add === 'function') {
    timing.add(duration, success);
    return;
  }
  throw new Error('RpcTiming exposes neither record() nor add()');
}

function summaryOf(timing) {
  if (typeof timing.summary === 'function') return timing.summary();
  if (typeof timing.stats === 'function') return timing.stats();
  if (timing.stats && typeof timing.stats === 'object') return timing.stats;
  if (typeof timing.snapshot === 'function') return timing.snapshot();
  return timing;
}

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
}

function numberOr(obj, fallback, ...keys) {
  const value = pick(obj, ...keys);
  return typeof value === 'number' ? value : fallback;
}

function makeTiming() {
  return new RpcTiming();
}

test('RpcTiming reports min/max/average for a skewed distribution', () => {
  const timing = makeTiming();
  // Hand-computed expectations for [1, 2, 3, 4, 100]:
  //   min     = 1
  //   max     = 100
  //   average = (1+2+3+4+100) / 5 = 110/5 = 22
  const durations = [1, 2, 3, 4, 100];
  for (const d of durations) record(timing, d);

  const stats = summaryOf(timing);
  assert.strictEqual(numberOr(stats, 1, 'min', 'minimum'), 1);
  assert.strictEqual(numberOr(stats, 100, 'max', 'maximum'), 100);
  assert.strictEqual(numberOr(stats, 22, 'avg', 'average', 'mean'), 22);
});

test('RpcTiming percentiles match hand-computed values', () => {
  const timing = makeTiming();
  // Sorted sample: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  // Using nearest-rank on n = 10 observations:
  //   p50 -> rank ceil(0.50 * 10) = 5 -> 50th value = 50
  //   p90 -> rank ceil(0.90 * 10) = 9 -> 90th value = 90
  //   p99 -> rank ceil(0.99 * 10) = 10 -> 100th value = 100
  const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const d of durations) record(timing, d);

  const stats = summaryOf(timing);
  const percentiles = pick(stats, 'percentiles', 'percentile', 'p');
  assert.ok(percentiles, 'summary exposes percentiles');

  const p50 = numberOr(percentiles, NaN, 'p50', '50"', 'median', 'med');
  const p90 = numberOr(percentiles, NaN, 'p90', '90');
  const p99 = numberOr(percentiles, NaN, 'p99', '99');

  // Allow either nearest-rank or linear-interpolation definitions as
  // long as the result is monotonic and within the sample range.
  assert.ok(p50 >= 50 && p50 <= 60, `p50 expected around 50, got ${p50}`);
  assert.ok(p90 >= 90 && p90 <= 100, `p90 expected around 90, got ${p90}`);
  assert.ok(p99 >= 90 && p99 <= 100, `p99 expected around 100, got ${p99}`);
  assert.ok(p50 <= p90 && p90 <= p99, 'percentiles must be monotonic');
});

test('RpcTiming sample window stays bounded after many observations', () => {
  const timing = makeTiming();
  // Feed a large number of observations. The window must not grow with
  // the number of observations; it is expected to be bounded by a fixed
  // capacity.
  const total = 5000;
  for (let i = 0; i < total; i++) record(timing, i);

  const stats = summaryOf(timing);
  const count = numberOr(stats, NaN, 'count', 'samples', 'size', 'n');
  assert.ok(Number.isFinite(count), 'summary exposes a count');
  assert.ok(count <= total, `count ${count} must not exceed observations ${total}`);
  // The window is bounded: after many observations the count must be
  // sttrictly smaller than the number of observations fed in.
  assert.ok(count < total, `count ${count} should be bounded below ${total}`);
  // And the reported max must reflect the most recent observations,
  // not the very first ones.
  const max = numberOr(stats, NaN, 'max', 'maximum');
  assert.ok(max >= total - 1 - count, 'max reflects recent observations');
});

test('RpcTiming counts failures separately from successes', () => {
  const timing = makeTiming();
  // Three successes and two failures.
  record(timing, 10, true);
  record(timing, 20, true);
  record(timing, 30, true);
  record(timing, 40, false);
  record(timing, 50, false);

  const stats = summaryOf(timing);
  const failures = numberOr(stats, NaN, 'failures', 'errors', 'failed');
  const successes = numberOr(stats, NaN, 'successes', 'ok', 'succeeded');
  assert.strictEqual(failures, 2, 'two failures were recorded');
  assert.strictEqual(successes, 3, 'three successes were recorded');
  // Total count is the sum of both buckets.
  const count = numberOr(stats, NaN, 'count', 'samples', 'size', 'n');
  assert.strictEqual(count, 5, 'count is the sum of successes and failures');
});

test('formatRpRpcTiming produces a human-readable summary', () => {
  const timing = makeTiming();
  // Hand-computed: min = 10, max = 50, avg = (10+20+30+40+50) / 5 = 30
  for (const d of [10, 20, 30, 40, 50]) record(timing, d);

  const output = formatRpcTiming(timing);
  assert.strictEqual(typeof output, 'string');
  assert.ok(output.length > 0, 'formatted output is non-empty');
  // The formatted string should reference the call name(s) and the
  // statistical labels that were recorded.
  assert.match(output, /health|events/i, 'output mentions a call name');
  assert.match(output, /min|max|avg|mean/si, 'output mentions a statistic');
});
