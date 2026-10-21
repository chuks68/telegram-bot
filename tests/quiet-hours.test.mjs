import assert from "node:assert/strict";
import test from "node:test";

import {
  decide,
  isInQuietHours,
  DeferredQueue,
  resolveEventName,
  DEFAULT_ALWAYS_SEND_EVENTS,
} from "../dist/notifications/quiet-hours.js";
import { formatDigest } from "../dist/notifications/format.js";

// Helper to construct a mock DecodedEvent
function mockEvent(name, category = "crypto") {
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    version: "v1",
    ledger: 1000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000001000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId: 1,
      category,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
}

// ---------------------------------------------------------------------------
// Pure decide() & Windows Crossing Midnight
// ---------------------------------------------------------------------------

test("decide(): defer non-critical events during quiet hours crossing midnight (22:00 to 06:00 UTC)", () => {
  const policy = {
    window: { start: 22, end: 6 },
    alwaysSend: ["claim_resolved"],
  };

  const normalEvent = mockEvent("claim_created");

  // Inside quiet hours (22:00 UTC)
  assert.equal(decide(normalEvent, policy, "2026-10-19T22:00:00Z"), "defer");
  assert.equal(decide(normalEvent, policy, 22), "defer");

  // Inside quiet hours (23:30 UTC)
  assert.equal(decide(normalEvent, policy, "2026-10-19T23:30:00Z"), "defer");

  // Inside quiet hours (00:00 UTC past midnight)
  assert.equal(decide(normalEvent, policy, "2026-10-20T00:00:00Z"), "defer");
  assert.equal(decide(normalEvent, policy, 0), "defer");

  // Inside quiet hours (03:15 UTC)
  assert.equal(decide(normalEvent, policy, "2026-10-20T03:15:00Z"), "defer");
  assert.equal(decide(normalEvent, policy, 3), "defer");

  // Inside quiet hours right before boundary (05:59:59 UTC)
  assert.equal(decide(normalEvent, policy, "2026-10-20T05:59:59Z"), "defer");

  // Outside quiet hours: exactly at 06:00 UTC boundary
  assert.equal(decide(normalEvent, policy, "2026-10-20T06:00:00Z"), "send");
  assert.equal(decide(normalEvent, policy, 6), "send");

  // Outside quiet hours (12:00 UTC midday)
  assert.equal(decide(normalEvent, policy, "2026-10-20T12:00:00Z"), "send");
  assert.equal(decide(normalEvent, policy, 12), "send");

  // Outside quiet hours right before start boundary (21:59:59 UTC)
  assert.equal(decide(normalEvent, policy, "2026-10-19T21:59:59Z"), "send");
});

test("decide(): daytime window that does not cross midnight (02:00 to 06:00 UTC)", () => {
  const policy = {
    window: { start: "02:00", end: "06:00" },
    alwaysSend: ["claim_resolved"],
  };

  const normalEvent = mockEvent("claim_created");

  assert.equal(decide(normalEvent, policy, "2026-10-20T01:59:59Z"), "send");
  assert.equal(decide(normalEvent, policy, "2026-10-20T02:00:00Z"), "defer");
  assert.equal(decide(normalEvent, policy, "2026-10-20T04:30:00Z"), "defer");
  assert.equal(decide(normalEvent, policy, "2026-10-20T06:00:00Z"), "send");
  assert.equal(decide(normalEvent, policy, "2026-10-20T23:00:00Z"), "send");
});

test("isInQuietHours(): handles tuple and alternative property specs", () => {
  assert.equal(
    isInQuietHours({ window: [22, 6] }, "2026-10-19T23:00:00Z"),
    true,
  );
  assert.equal(
    isInQuietHours({ utcWindow: { startUtc: "22:00", endUtc: "06:00" } }, "2026-10-20T01:00:00Z"),
    true,
  );
  assert.equal(
    isInQuietHours({ startHour: 22, endHour: 6 }, "2026-10-20T08:00:00Z"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Critical Events Always Pass
// ---------------------------------------------------------------------------

test("decide(): critical events always pass, even in the middle of quiet hours", () => {
  const policy = {
    window: { start: 22, end: 6 },
    alwaysSend: new Set(["claim_resolved", "market_settled"]),
  };

  const critical1 = mockEvent("claim_resolved");
  const critical2 = mockEvent("market_settled");
  const nonCritical = mockEvent("claim_created");

  const midnight = new Date(Date.UTC(2026, 9, 20, 1, 0, 0)); // 01:00 UTC

  // Non-critical is deferred
  assert.equal(decide(nonCritical, policy, midnight), "defer");

  // Critical events must ALWAYS pass ("send")
  assert.equal(decide(critical1, policy, midnight), "send");
  assert.equal(decide(critical2, policy, midnight), "send");
});

test("decide(): handles duck-typed objects and custom alwaysSend aliases", () => {
  const policy = {
    window: { start: 20, end: 4 },
    alwaysSendEvents: ["emergency_action"],
  };

  const duckTypedCritical = { payload: { name: "emergency_action" } };
  const duckTypedNormal = { payload: { name: "regular_action" } };
  const nameOnlyCritical = { name: "emergency_action" };

  assert.equal(decide(duckTypedCritical, policy, "2026-10-19T22:00:00Z"), "send");
  assert.equal(decide(nameOnlyCritical, policy, "2026-10-19T22:00:00Z"), "send");
  assert.equal(decide(duckTypedNormal, policy, "2026-10-19T22:00:00Z"), "defer");
});

test("decide(): returns send when no quiet hours policy or empty window configured", () => {
  const event = mockEvent("claim_created");
  assert.equal(decide(event, {}, "2026-10-19T22:00:00Z"), "send");
  assert.equal(decide(event, { window: { start: 10, end: 10 } }, "2026-10-19T10:00:00Z"), "send");
});

// ---------------------------------------------------------------------------
// Bounded DeferredQueue & Overflow Counting
// ---------------------------------------------------------------------------

test("DeferredQueue: enforces capacity cap and counts overflows accurately", () => {
  const queue = new DeferredQueue(3);
  assert.equal(queue.maxSize, 3);
  assert.equal(queue.size, 0);
  assert.equal(queue.overflowCount, 0);

  const e1 = mockEvent("e1");
  const e2 = mockEvent("e2");
  const e3 = mockEvent("e3");
  const e4 = mockEvent("e4");
  const e5 = mockEvent("e5");

  assert.equal(queue.enqueue(e1), true);
  assert.equal(queue.enqueue(e2), true);
  assert.equal(queue.enqueue(e3), true);
  assert.equal(queue.size, 3);
  assert.equal(queue.overflowCount, 0);

  // Exceeding capacity drops events and increments overflowCount
  assert.equal(queue.enqueue(e4), false);
  assert.equal(queue.size, 3, "size must not grow beyond capacity");
  assert.equal(queue.overflowCount, 1);
  assert.equal(queue.overflows, 1);

  assert.equal(queue.enqueue(e5), false);
  assert.equal(queue.size, 3);
  assert.equal(queue.overflowCount, 2);

  // Peek shows existing events in order
  const queued = queue.peek();
  assert.equal(queued.length, 3);
  assert.equal(queued[0].payload.name, "e1");
  assert.equal(queued[1].payload.name, "e2");
  assert.equal(queued[2].payload.name, "e3");
});

test("DeferredQueue: flush() releases queued events and retains overflow count", () => {
  const queue = new DeferredQueue({ maxSize: 2 });
  queue.enqueue(mockEvent("a"));
  queue.enqueue(mockEvent("b"));
  queue.enqueue(mockEvent("c")); // overflow

  assert.equal(queue.overflowCount, 1);

  const flushed = queue.flush();
  assert.equal(flushed.length, 2);
  assert.equal(flushed.overflowCount, 1);
  assert.equal(queue.size, 0);
  assert.equal(queue.isEmpty(), true);
});

// ---------------------------------------------------------------------------
// flushDue(now) & formatDigest Integration
// ---------------------------------------------------------------------------

test("DeferredQueue: flushDue(now) holds events during quiet hours and releases them when quiet hours end", () => {
  const policy = {
    window: { start: 22, end: 6 },
    alwaysSend: ["claim_resolved"],
  };

  const queue = new DeferredQueue({ maxSize: 10, policy });

  const event1 = mockEvent("claim_created");
  const event2 = mockEvent("claim_challenged");

  queue.enqueue(event1);
  queue.enqueue(event2);

  // During quiet hours (23:00 UTC), flushDue returns empty array and retains queue
  const duringQuiet = queue.flushDue("2026-10-19T23:00:00Z");
  assert.equal(duringQuiet.length, 0);
  assert.equal(queue.size, 2);

  // Still during quiet hours (04:00 UTC)
  const stillQuiet = queue.flushDue("2026-10-20T04:00:00Z");
  assert.equal(stillQuiet.length, 0);
  assert.equal(queue.size, 2);

  // Quiet hours end at 06:00 UTC
  const released = queue.flushDue("2026-10-20T06:00:00Z");
  assert.equal(released.length, 2);
  assert.equal(queue.size, 0);

  // Verify compatibility with formatDigest
  const digest = formatDigest(released);
  assert.ok(digest);
  assert.match(digest, /Mimir Digest.*2 events/);

  // Subsequent flush returns empty because queue was drained
  const afterRelease = queue.flushDue("2026-10-20T06:05:00Z");
  assert.equal(afterRelease.length, 0);
});

test("DeferredQueue: flushDigest(now) formats directly using formatDigest", () => {
  const policy = {
    window: { start: 22, end: 6 },
  };

  const queue = new DeferredQueue(5, policy);
  queue.enqueue(mockEvent("claim_created"));

  // While quiet, returns null (empty events format to null in formatDigest)
  const during = queue.flushDigest("2026-10-19T23:00:00Z");
  assert.equal(during, null);

  // When quiet hours finish, returns formatted digest string
  const after = queue.flushDigest("2026-10-20T06:00:00Z");
  assert.ok(typeof after === "string");
  assert.match(after, /Mimir Digest/);
});
