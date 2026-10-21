/**
 * tests/digest-golden.test.mjs
 *
 * Golden tests locking the output format of formatDigest for coalesced bursts.
 * Ensures mixed-source bursts, MarkdownV2 field escaping, empty bursts, and
 * long bursts match reviewed and committed expected strings character-for-character.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDigest,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000,
    txHash: "0".repeat(64),
    at: 1700000000,
    eventId: "evt-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name: "unknown", eventName: "test_event" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Committed Inline Golden Expectations
// ---------------------------------------------------------------------------

const EXPECTED_2_EVENTS = [
  "*Mimir Digest* — 2 events in this cycle",
  "",
  "· mimir\\-market `claim\\_created` at ledger 1000",
  "· mimir\\-squad `risk\\_flag\\(v1\\.2\\)\\-alert\\!` at ledger 1001",
].join("\n");

const EXPECTED_5_EVENTS = [
  "*Mimir Digest* — 5 events in this cycle",
  "",
  "· mimir\\-market `claim\\_created` at ledger 2000",
  "· mimir\\-squad `deposited` at ledger 2001",
  "· mimir\\-market `claim\\_challenged` at ledger 2002",
  "· mimir\\-squad `resolved` at ledger 2003",
  "· mimir\\-market `policy\\_override\\[v2\\.0\\]\\*strict\\*` at ledger 2004",
].join("\n");

const EXPECTED_40_EVENTS = [
  "*Mimir Digest* — 40 events in this cycle",
  "",
  "· mimir\\-market `claim\\_created` at ledger 3001",
  "· mimir\\-squad `market\\_created` at ledger 3002",
  "· mimir\\-market `claim\\_challenged` at ledger 3003",
  "· mimir\\-squad `deposited` at ledger 3004",
  "· mimir\\-market `claim\\_resolved` at ledger 3005",
  "· mimir\\-squad `withdrawn` at ledger 3006",
  "· mimir\\-market `claim\\_cancelled` at ledger 3007",
  "· mimir\\-squad `resolved` at ledger 3008",
  "· mimir\\-market `market\\_settled` at ledger 3009",
  "· mimir\\-squad `claimed` at ledger 3010",
  "· mimir\\-market `challenger\\_paid` at ledger 3011",
  "· mimir\\-squad `fees\\_claimed` at ledger 3012",
  "· mimir\\-market `fee\\_claimed` at ledger 3013",
  "· mimir\\-squad `deposited` at ledger 3014",
  "· mimir\\-market `withdrawal` at ledger 3015",
  "· mimir\\-squad `withdrawn` at ledger 3016",
  "· mimir\\-market `withdrawal\\_pending` at ledger 3017",
  "· mimir\\-squad `resolved` at ledger 3018",
  "· mimir\\-market `claim\\_created` at ledger 3019",
  "· mimir\\-squad `claimed` at ledger 3020",
  "· mimir\\-market `oracle\\_override\\(v1\\.0\\)\\-alert\\!` at ledger 3021",
  "· mimir\\-squad `market\\_created` at ledger 3022",
  "· mimir\\-market `claim\\_challenged` at ledger 3023",
  "· mimir\\-squad `deposited` at ledger 3024",
  "· mimir\\-market `claim\\_resolved` at ledger 3025",
  "· mimir\\-squad `withdrawn` at ledger 3026",
  "· mimir\\-market `claim\\_cancelled` at ledger 3027",
  "· mimir\\-squad `resolved` at ledger 3028",
  "· mimir\\-market `market\\_settled` at ledger 3029",
  "· mimir\\-squad `claimed` at ledger 3030",
  "· mimir\\-market `challenger\\_paid` at ledger 3031",
  "· mimir\\-squad `fees\\_claimed` at ledger 3032",
  "· mimir\\-market `fee\\_claimed` at ledger 3033",
  "· mimir\\-squad `deposited` at ledger 3034",
  "· mimir\\-market `withdrawal` at ledger 3035",
  "· mimir\\-squad `withdrawn` at ledger 3036",
  "· mimir\\-market `withdrawal\\_pending` at ledger 3037",
  "· mimir\\-squad `resolved` at ledger 3038",
  "· mimir\\-market `claim\\_created` at ledger 3039",
  "· mimir\\-squad `squad\\_sync\\~state\\#40\\+active` at ledger 3040",
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("formatDigest: returns null for an empty event list", () => {
  assert.equal(formatDigest([]), null);
  assert.equal(formatDigest([], { grouped: true }), null);
});

test("formatDigest: 2-event digest matches inline golden string", () => {
  const events = [
    makeEvent({
      source: "market",
      ledger: 1000,
      payload: { name: "claim_created", claimId: 1, creator: "G1", category: "sports" },
    }),
    makeEvent({
      source: "squad",
      ledger: 1001,
      payload: { name: "unknown", eventName: "risk_flag(v1.2)-alert!" },
    }),
  ];

  const result = formatDigest(events);
  assert.ok(result !== null);
  assert.equal(result, EXPECTED_2_EVENTS);
  assert.ok(result.length <= TELEGRAM_MAX_MESSAGE_LENGTH);

  const parts = splitTelegramMessage(result);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], result);
});

test("formatDigest: 5-event digest matches inline golden string with MarkdownV2 escaping", () => {
  const events = [
    makeEvent({
      source: "market",
      ledger: 2000,
      payload: { name: "claim_created", claimId: 10, creator: "G1", category: "crypto" },
    }),
    makeEvent({
      source: "squad",
      ledger: 2001,
      payload: { name: "deposited", marketId: 5, participant: "G2", amount: 10000000n, side: 1 },
    }),
    makeEvent({
      source: "market",
      ledger: 2002,
      payload: { name: "claim_challenged", claimId: 10, challenger: "G3", stake: 50000000n },
    }),
    makeEvent({
      source: "squad",
      ledger: 2003,
      payload: { name: "resolved", marketId: 5, result: 1, poolA: 10000000n, poolB: 20000000n },
    }),
    makeEvent({
      source: "market",
      ledger: 2004,
      payload: { name: "unknown", eventName: "policy_override[v2.0]*strict*" },
    }),
  ];

  const result = formatDigest(events);
  assert.ok(result !== null);
  assert.equal(result, EXPECTED_5_EVENTS);
  assert.ok(result.length <= TELEGRAM_MAX_MESSAGE_LENGTH);

  const parts = splitTelegramMessage(result);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], result);
});

test("formatDigest: 40-event digest matches inline golden string and fits within TELEGRAM_MAX_MESSAGE_LENGTH", () => {
  const eventDefs = [
    { source: "market", payload: { name: "claim_created", claimId: 1 } },
    { source: "squad", payload: { name: "market_created", marketId: 101 } },
    { source: "market", payload: { name: "claim_challenged", claimId: 1 } },
    { source: "squad", payload: { name: "deposited", marketId: 101 } },
    { source: "market", payload: { name: "claim_resolved", claimId: 1 } },
    { source: "squad", payload: { name: "withdrawn", marketId: 101 } },
    { source: "market", payload: { name: "claim_cancelled", claimId: 2 } },
    { source: "squad", payload: { name: "resolved", marketId: 101 } },
    { source: "market", payload: { name: "market_settled", claimId: 1 } },
    { source: "squad", payload: { name: "claimed", marketId: 101 } },
    { source: "market", payload: { name: "challenger_paid", claimId: 1 } },
    { source: "squad", payload: { name: "fees_claimed" } },
    { source: "market", payload: { name: "fee_claimed" } },
    { source: "squad", payload: { name: "deposited", marketId: 102 } },
    { source: "market", payload: { name: "withdrawal" } },
    { source: "squad", payload: { name: "withdrawn", marketId: 102 } },
    { source: "market", payload: { name: "withdrawal_pending" } },
    { source: "squad", payload: { name: "resolved", marketId: 102 } },
    { source: "market", payload: { name: "claim_created", claimId: 3 } },
    { source: "squad", payload: { name: "claimed", marketId: 102 } },
    { source: "market", payload: { name: "unknown", eventName: "oracle_override(v1.0)-alert!" } },
    { source: "squad", payload: { name: "market_created", marketId: 103 } },
    { source: "market", payload: { name: "claim_challenged", claimId: 3 } },
    { source: "squad", payload: { name: "deposited", marketId: 103 } },
    { source: "market", payload: { name: "claim_resolved", claimId: 3 } },
    { source: "squad", payload: { name: "withdrawn", marketId: 103 } },
    { source: "market", payload: { name: "claim_cancelled", claimId: 4 } },
    { source: "squad", payload: { name: "resolved", marketId: 103 } },
    { source: "market", payload: { name: "market_settled", claimId: 3 } },
    { source: "squad", payload: { name: "claimed", marketId: 103 } },
    { source: "market", payload: { name: "challenger_paid", claimId: 3 } },
    { source: "squad", payload: { name: "fees_claimed" } },
    { source: "market", payload: { name: "fee_claimed" } },
    { source: "squad", payload: { name: "deposited", marketId: 104 } },
    { source: "market", payload: { name: "withdrawal" } },
    { source: "squad", payload: { name: "withdrawn", marketId: 104 } },
    { source: "market", payload: { name: "withdrawal_pending" } },
    { source: "squad", payload: { name: "resolved", marketId: 104 } },
    { source: "market", payload: { name: "claim_created", claimId: 5 } },
    { source: "squad", payload: { name: "unknown", eventName: "squad_sync~state#40+active" } },
  ];

  const events = eventDefs.map((def, idx) =>
    makeEvent({
      source: def.source,
      ledger: 3001 + idx,
      payload: def.payload,
    }),
  );

  const result = formatDigest(events);
  assert.ok(result !== null);
  assert.equal(result, EXPECTED_40_EVENTS);
  assert.ok(result.length <= TELEGRAM_MAX_MESSAGE_LENGTH);

  // Unsplit result fits in single chunk
  const singleParts = splitTelegramMessage(result, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.equal(singleParts.length, 1);
  assert.equal(singleParts[0], result);

  // Clean split when limit is smaller than total digest length
  const splitParts = splitTelegramMessage(result, 500);
  assert.ok(splitParts.length > 1);
  for (const part of splitParts) {
    assert.ok(part.length <= 500);
    // Boundary check: must not end on an unescaped trailing odd backslash
    const trailingSlashes = part.match(/\\+$/)?.[0]?.length ?? 0;
    assert.equal(trailingSlashes % 2, 0, "chunk boundary must not split escape sequence");
  }
  assert.equal(splitParts.join("\n"), result);
});

test("formatDigest: oversized burst exceeding TELEGRAM_MAX_MESSAGE_LENGTH is split by splitTelegramMessage cleanly", () => {
  // Construct 40 events with long field names such that the total digest exceeds 4096 chars
  const events = [];
  for (let i = 0; i < 40; i++) {
    const longName = `event_operation_log_audit_action_verification_tag_${String(i).padStart(2, "0")}_payload_field_detail`;
    events.push(
      makeEvent({
        source: i % 2 === 0 ? "market" : "squad",
        ledger: 4000 + i,
        payload: { name: "unknown", eventName: longName },
      }),
    );
  }

  const result = formatDigest(events);
  assert.ok(result !== null);
  assert.ok(result.length > TELEGRAM_MAX_MESSAGE_LENGTH, "Burst must exceed Telegram message limit");

  const chunks = splitTelegramMessage(result, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.ok(chunks.length > 1, "Must be split into multiple chunks");

  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE_LENGTH, "Each chunk must fit limit");
    const trailingSlashes = chunk.match(/\\+$/)?.[0]?.length ?? 0;
    assert.equal(trailingSlashes % 2, 0, "No chunk ends on a broken escape sequence");
  }

  assert.equal(chunks.join("\n"), result, "Recombined chunks match original digest");
});
