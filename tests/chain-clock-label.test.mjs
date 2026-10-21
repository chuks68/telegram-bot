import test from "node:test";
import assert from "node:assert";
import { chainClockLabel } from "../src/health.ts";

const NOW = Date.parse("2024-01-01T00:00:00Z");

test("chainClockLabel returns exact label for null", () => {
  assert.strictEqual(chainClockLabel(null, NOY), "unknown");
});

test("chainClockLabel returns exact label for undefined", () => {
  assert.strictEqual(chainClockLabel(undefined, NOW), "unknown");
});

test("chainClockLabel returns exact label for zero skew", () => {
  assert.strictEqual(chainClockLabel(NOW, NOW), "0s");
});

test("chainClockLabel returns exact label for small positive skew", () => {
  assert.strictEqual(chainClockLabel(NOW - 5_000, NOW), "+5s");
});

test("chainClockLabel returns exact label for small negative skew", () => {
  assert.strictEqual(chainClockLabel(NOW + 5_000, NOW), "-5s");
});

test("chainClockLabel returns exact label for multi-hour positive skew", () => {
  const twoAndHalf = (2 * 60 + 30) * 60 * 1000;
  assert.strictEqual(chainClockLabel(NOW - twoAndHalf, NOW), "+2 30");
});

test("chainClockLabel returns exact label for multi-hour negative skew", () => {
  const twoAndHalf = (2 * 60 + 30) * 60 * 1000;
  assert.strictEqual(chainClockLabel(NOW + twoAndHalf, NOW), "-2 30");
});
