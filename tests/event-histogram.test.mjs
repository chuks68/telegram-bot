import test from "node:test";
import assert from "node:assert";
import { eventHistogram } from "../src/stellar/events.js";

// Deterministic key order rule:
// eventHistogram returns a plain object whose keys are inserted in first-seen order
// of the input events. This is the JS spec order for string keys that are not
// array indices, so the histogram is stable and safe to serialize into scan
// JSON output without additional sorting.

test("eventHistogram returns an empty object for empty input", () => {
  const result = eventHistogram([]);
  assert.deepStrictEqual(result, {});
});

test("eventHistogram counts a single event", () => {
  const result = eventHistogram([{ name: "market_created" }]);
  assert.deepStrictEqual(result, { market_created: 1 });
});

test("eventHistogram counts mixed market and squad names", () => {
  const result = eventHistogram([
    { name: "market_created" },
    { name: "squad_joined" },
    { name: "market_created" },
    { name: "squad_joined" },
    { name: "market_resolved" },
  ]);
  assert.deepStrictEqual(result, {
    market_created: 2,
    squad_joined: 2,
    market_resolved: 1,
  });
  // Key order is first-seen order of the input.
  assert.deepStrictEqual(Object.keys(result), [
    "market_created",
    "squad_joined",
    "market_resolved",
  ]);
});

test("eventHistogram includes unknown events", () => {
  const result = eventHistogram([
    { name: "market_created" },
    { name: "unknown_event" },
    { name: "unknown_event" },
  ]);
  assert.deepStrictEqual(result, {
    market_created: 1,
    unknown_event: 2,
  });
  assert.deepStrictEqual(Object.keys(result), ["market_created", "unknown_event"]);
});
