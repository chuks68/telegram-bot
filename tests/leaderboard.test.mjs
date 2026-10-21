import assert from "node:assert/strict";
import test from "node:test";

import { buildLeaderboard } from "../dist/stellar/leaderboard.js";
import { leaderboardMessage } from "../dist/notifications/leaderboard.js";
import { formatUsdc, shortAddress } from "../dist/stellar/decode.js";

function makeEvent(payload, overrides = {}) {
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: 1700000000,
    eventId: "1000-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
    ...overrides,
  };
}

function challengerPaidEvent(challenger, stake, net, extra = {}) {
  return makeEvent({
    name: "challenger_paid",
    claimId: 42,
    challenger,
    stake: BigInt(stake),
    gross: BigInt(stake) + BigInt(net),
    fee: 0n,
    net: BigInt(net),
    ...extra,
  });
}

test("empty input returns empty leaderboard and informative empty message", () => {
  assert.deepEqual(buildLeaderboard([]), []);
  assert.deepEqual(buildLeaderboard(null), []);
  assert.deepEqual(buildLeaderboard(undefined), []);

  const msgEmpty = leaderboardMessage([]);
  assert.match(msgEmpty, /Leaderboard/i);
  assert.match(msgEmpty, /No settlements recorded/i);

  const msgNull = leaderboardMessage(null);
  assert.match(msgNull, /No settlements recorded/i);
});

test("non-challenger_paid events are ignored", () => {
  const events = [
    makeEvent({ name: "claim_created", claimId: 1, creator: "GCREATOR", category: "test" }),
    makeEvent({ name: "claim_challenged", claimId: 1, challenger: "GCHALLENGER_A", stake: 50_000_000n }),
    makeEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "resolved", confidence: 100, evidenceHash: "abc" }),
    makeEvent({ name: "market_settled", claimId: 1, totalPaid: 100_000_000n, totalFees: 0n, owedToChallengers: 100_000_000n, dust: 0n }),
    makeEvent({ name: "unknown", eventName: "foo" }),
  ];

  const result = buildLeaderboard(events);
  assert.deepEqual(result, []);
});

test("aggregates multiple events per challenger summing stake and net as bigint and counting wins", () => {
  const alice = "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const bob = "GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const events = [
    challengerPaidEvent(alice, 10_000_000n, 15_000_000n),
    challengerPaidEvent(alice, 20_000_000n, 25_000_000n),
    challengerPaidEvent(bob, 50_000_000n, 10_000_000n),
  ];

  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 2);

  // Alice: net 40_000_000n, stake 30_000_000n, 2 wins
  assert.equal(rows[0].challenger, alice);
  assert.equal(rows[0].address, alice);
  assert.equal(rows[0].net, 40_000_000n);
  assert.equal(rows[0].stake, 30_000_000n);
  assert.equal(rows[0].wins, 2);

  // Bob: net 10_000_000n, stake 50_000_000n, 1 win
  assert.equal(rows[1].challenger, bob);
  assert.equal(rows[1].net, 10_000_000n);
  assert.equal(rows[1].stake, 50_000_000n);
  assert.equal(rows[1].wins, 1);
});

test("breaks ties deterministically by address", () => {
  const addrA = "GA1111111111111111111111111111111111111111111111111111111";
  const addrB = "GB2222222222222222222222222222222222222222222222222222222";
  const addrC = "GC3333333333333333333333333333333333333333333333333333333";

  // Feed in reverse alphabetical order with identical net
  const events = [
    challengerPaidEvent(addrC, 10_000_000n, 20_000_000n),
    challengerPaidEvent(addrB, 10_000_000n, 20_000_000n),
    challengerPaidEvent(addrA, 10_000_000n, 20_000_000n),
  ];

  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].challenger, addrA);
  assert.equal(rows[1].challenger, addrB);
  assert.equal(rows[2].challenger, addrC);

  // Re-ordering inputs produces identical result
  const events2 = [
    challengerPaidEvent(addrB, 10_000_000n, 20_000_000n),
    challengerPaidEvent(addrA, 10_000_000n, 20_000_000n),
    challengerPaidEvent(addrC, 10_000_000n, 20_000_000n),
  ];
  const rows2 = buildLeaderboard(events2);
  assert.deepEqual(rows, rows2);
});

test("handles large amounts without overflow or precision loss", () => {
  const addr = "GHUGEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const hugeStake = 123_456_789_012_345_678_901_234_567n;
  const hugeNet = 987_654_321_098_765_432_109_876_543n;

  const events = [
    challengerPaidEvent(addr, hugeStake, hugeNet),
    challengerPaidEvent(addr, hugeStake, hugeNet),
  ];

  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stake, hugeStake * 2n);
  assert.equal(rows[0].net, hugeNet * 2n);
  assert.equal(rows[0].wins, 2);

  const message = leaderboardMessage(rows);
  assert.match(message, new RegExp(formatUsdc(hugeNet * 2n).replace(".", "\\\\.")));
});

test("supports { limit } option", () => {
  const events = [
    challengerPaidEvent("G1", 1n, 100n),
    challengerPaidEvent("G2", 1n, 200n),
    challengerPaidEvent("G3", 1n, 300n),
  ];

  const top2 = buildLeaderboard(events, { limit: 2 });
  assert.equal(top2.length, 2);
  assert.equal(top2[0].challenger, "G3");
  assert.equal(top2[1].challenger, "G2");

  const zero = buildLeaderboard(events, { limit: 0 });
  assert.equal(zero.length, 0);

  const all = buildLeaderboard(events, { limit: 10 });
  assert.equal(all.length, 3);
});

test("leaderboardMessage formats rows using shortAddress and formatUsdc", () => {
  const alice = "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const bob = "GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const rows = [
    { challenger: alice, address: alice, net: 20_000_000n, stake: 10_000_000n, wins: 2 },
    { challenger: bob, address: bob, net: 15_000_000n, stake: 5_000_000n, wins: 1 },
  ];

  const message = leaderboardMessage(rows);

  // Contains title
  assert.match(message, /🏆 \*Challenger Leaderboard\*/);

  // Contains shortened addresses
  assert.match(message, new RegExp(shortAddress(alice)));
  assert.match(message, new RegExp(shortAddress(bob)));

  // Contains formatted USDC net
  assert.match(message, /2\\\.0000000 USDC/);
  assert.match(message, /1\\\.5000000 USDC/);

  // Contains win counts
  assert.match(message, /2 wins/);
  assert.match(message, /1 win/);
});
