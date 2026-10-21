import assert from "node:assert/strict";
import test from "node:test";

import { dedupeEvents } from "../dist/stellar/decode.js";

/** Helper to build a minimal decoded event fixture matching EventMeta and a payload. */
function makeEvent(eventId, overrides = {}) {
  return {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    version: "v1",
    ledger: 100,
    txHash: "a".repeat(64),
    at: 1700000000,
    eventId,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 1,
      creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      category: "crypto",
    },
    ...overrides,
  };
}

test("no duplicates: retains all events and preserves original order", () => {
  const e1 = makeEvent("100-1", { ledger: 100 });
  const e2 = makeEvent("100-2", { ledger: 100 });
  const e3 = makeEvent("101-1", { ledger: 101 });
  const input = [e1, e2, e3];
  const inputSnapshot = [...input];

  const result = dedupeEvents(input);

  assert.deepEqual(result, [e1, e2, e3]);
  assert.equal(result[0], e1);
  assert.equal(result[1], e2);
  assert.equal(result[2], e3);
  assert.deepEqual(input, inputSnapshot);
});

test("adjacent duplicates: keeps the first occurrence and preserves original order", () => {
  const e1 = makeEvent("100-1");
  const e1Dup = makeEvent("100-1", { at: 1700000001 });
  const e2 = makeEvent("100-2");
  const e2Dup = makeEvent("100-2", { at: 1700000002 });
  const e3 = makeEvent("100-3");
  const input = [e1, e1Dup, e2, e2Dup, e3];
  const inputSnapshot = [...input];

  const result = dedupeEvents(input);

  assert.deepEqual(result, [e1, e2, e3]);
  assert.equal(result[0], e1);
  assert.equal(result[1], e2);
  assert.equal(result[2], e3);
  assert.deepEqual(input, inputSnapshot);
});

test("non-adjacent duplicates across overlapping pages: keeps the first occurrence and preserves order", () => {
  const e1 = makeEvent("100-1");
  const e2 = makeEvent("100-2");
  const e3 = makeEvent("100-3");
  const e1Dup = makeEvent("100-1", { at: 1700000010 });
  const e4 = makeEvent("100-4");
  const e2Dup = makeEvent("100-2", { at: 1700000020 });
  const input = [e1, e2, e3, e1Dup, e4, e2Dup];
  const inputSnapshot = [...input];

  const result = dedupeEvents(input);

  assert.deepEqual(result, [e1, e2, e3, e4]);
  assert.equal(result[0], e1);
  assert.equal(result[1], e2);
  assert.equal(result[2], e3);
  assert.equal(result[3], e4);
  assert.deepEqual(input, inputSnapshot);
});

test("duplicates with differing payload objects: retains first occurrence payload", () => {
  const first = makeEvent("100-1", {
    payload: {
      name: "claim_created",
      claimId: 1,
      creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      category: "crypto",
    },
  });
  const duplicateWithDifferentPayload = makeEvent("100-1", {
    payload: {
      name: "claim_resolved",
      claimId: 1,
      winnerSide: 1,
      summary: "Resolved first occurrence wins",
      confidence: 100,
      evidenceHash: "00",
    },
  });
  const nextEvent = makeEvent("100-2", {
    payload: {
      name: "claim_cancelled",
      claimId: 2,
    },
  });
  const input = [first, duplicateWithDifferentPayload, nextEvent];
  const inputSnapshot = [...input];

  const result = dedupeEvents(input);

  assert.deepEqual(result, [first, nextEvent]);
  assert.equal(result[0], first);
  assert.equal(result[0].payload.name, "claim_created");
  assert.equal(result[1], nextEvent);
  assert.deepEqual(input, inputSnapshot);
});

test("does not mutate the input array (including frozen input arrays)", () => {
  const e1 = makeEvent("100-1");
  const e1Dup = makeEvent("100-1");
  const e2 = makeEvent("100-2");
  const inputArray = Object.freeze([e1, e1Dup, e2]);

  assert.doesNotThrow(() => {
    const result = dedupeEvents(inputArray);
    assert.deepEqual(result, [e1, e2]);
    assert.equal(result[0], e1);
    assert.equal(result[1], e2);
  });
});
