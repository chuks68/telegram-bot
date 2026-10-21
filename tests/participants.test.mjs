import test from "node:test";
import assert from "node:assert";
import { participantSummary } from "../src/stellar/participants.ts";

test("participantSummary returns zeros for empty input", () => {
  assert.deepEqual(participantSummary([]), {
    creators: 0,
    challengers: 0,
    depositors: 0,
    claimers: 0,
    total: 0,
  });
});

test("participantSummary counts unique addresses per role and overall", () => {
  const events = [
    { name: "create_challenge", payload: { creator: "GAAAA", challenger: "GBBBB" } },
    { name: "create_challenge", payload: { creator: "GAAAA", challenger: "GCCCC" } },
    { name: "deposit", payload: { participant: "GCCCC" } },
    { name: "claim", payload: { recipient: "GBBBB" } },
  ];

  assert.deepEqual(participantSummary(events), {
    creators: 1,
    challengers: 2,
    depositors: 1,
    claimers: 1,
    total: 3,
  });
});

test("participantSummary counts same address in two roles once overall and once per role", () => {
  const events = [
    { name: "create_challenge", payload: { creator: "GXXXX", challenger: "GXXXX" } },
    { name: "deposit", payload: { participant: "GXXXX" } },
    { name: "claim", payload: { recipient: "GXYYY" } },
  ];

  assert.deepEqual(participantSummary(events), {
    creators: 1,
    challengers: 1,
    depositors: 1,
    claimers: 1,
    total: 2,
  });
});

test("participantSummary ignores admin and unknown events", () => {
  const events = [
    { name: "admin_set", payload: { admin: "GADMIN", creator: "GNOPER" } },
    { name: "unknown_event", payload: { participant: "GNOPE" } },
    { name: "deposit", payload: { participant: "GDEP", admin: "GADMIN" } },
  ];

  assert.deepEqual(participantSummary(events), {
    creators: 0,
    challengers: 0,
    depositors: 1,
    claimers: 0,
    total: 1,
  });
});
