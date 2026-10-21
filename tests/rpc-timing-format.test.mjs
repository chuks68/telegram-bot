/**
 * Tests for formatRpcTiming string representation in src/stellar/metrics.ts.
 *
 * Verifies exact string formatting and ensures no NaN, undefined, or Infinity
 * appears in any status output across empty summaries, single sample states,
 * and multi-sample aggregates.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatRpcTiming, RpcTiming } from "../dist/stellar/metrics.js";

/**
 * Asserts that the output contains no NaN, undefined, or Infinity.
 */
function assertCleanOutput(str) {
  assert.ok(!str.includes("NaN"), `Output contains NaN: "${str}"`);
  assert.ok(!str.includes("undefined"), `Output contains undefined: "${str}"`);
  assert.ok(!str.includes("Infinity"), `Output contains Infinity: "${str}"`);
  assert.doesNotMatch(str, /NaN|undefined|Infinity/);
}

test("formatRpcTiming: empty summary renders zeroes and no NaN/undefined/Infinity", () => {
  const timing = new RpcTiming(() => 0);
  const summary = timing.summary();
  const formatted = formatRpcTiming(summary);

  assert.equal(
    formatted,
    "rpc requests=0 failures=0 total=0ms avg=0ms max=0ms health=0 events=0",
  );
  assertCleanOutput(formatted);
});

test("formatRpcTiming: one health sample renders exact string", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 15, true);

  const summary = timing.summary();
  const formatted = formatRpcTiming(summary);

  assert.equal(
    formatted,
    "rpc requests=1 failures=0 total=15ms avg=15ms max=15ms health=1 events=0",
  );
  assertCleanOutput(formatted);
});

test("formatRpcTiming: one failed events sample renders exact string", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("events", 25, false);

  const summary = timing.summary();
  const formatted = formatRpcTiming(summary);

  assert.equal(
    formatted,
    "rpc requests=1 failures=1 total=25ms avg=25ms max=25ms health=0 events=1",
  );
  assertCleanOutput(formatted);
});

test("formatRpcTiming: many samples render exact aggregate string", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 10, true);
  timing.record("health", 20, true);
  timing.record("events", 30, true);
  timing.record("events", 40, false);

  const summary = timing.summary();
  const formatted = formatRpcTiming(summary);

  assert.equal(
    formatted,
    "rpc requests=4 failures=1 total=100ms avg=25ms max=40ms health=2 events=2",
  );
  assertCleanOutput(formatted);
});

test("formatRpcTiming: many samples with fractional durations rounded cleanly", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 1.25, true);
  timing.record("events", 3.75, false);

  const summary = timing.summary();
  const formatted = formatRpcTiming(summary);

  assert.equal(
    formatted,
    "rpc requests=2 failures=1 total=5ms avg=2.5ms max=3.75ms health=1 events=1",
  );
  assertCleanOutput(formatted);
});
