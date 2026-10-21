import assert from "node:assert/strict";
import test from "node:test";

import { feeAccrual, isAdminPayload } from "../dist/stellar/fee-accrual.js";

// Deterministic test addresses
const RECIPIENT_A = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA";
const RECIPIENT_B = "GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVBBB";
const RECIPIENT_C = "GC7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJCCCC";

const CONTRACT_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const CONTRACT_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2";

function mockEvent(options = {}) {
  const name = options.name ?? "fee_accrued";
  const recipient = "recipient" in options ? options.recipient : RECIPIENT_A;
  const amount = "amount" in options ? options.amount : 10_000_000n;
  const contractId = "contractId" in options ? options.contractId : CONTRACT_1;
  const ledger = options.ledger ?? 1000;
  const txHash = options.txHash ?? "hash123";
  const extra = options.extra ?? {};

  const payload = {
    name,
    ...(recipient !== undefined ? { recipient } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...extra,
  };

  return {
    source: "market",
    contractId,
    version: "v1",
    ledger,
    txHash,
    at: 1700000000,
    eventId: `${ledger}-1`,
    eventType: "contract",
    payload,
  };
}

// ── Empty and Invalid Inputs ────────────────────────────────────────────────

test("feeAccrual: handles empty, null, or undefined event streams gracefully", () => {
  for (const emptyInput of [[], null, undefined]) {
    const report = feeAccrual(emptyInput);
    assert.equal(report.total, 0n);
    assert.equal(report.totalAmount, 0n);
    assert.equal(report.count, 0);
    assert.equal(report.totalEvents, 0);
    assert.equal(report.missingAmountCount, 0);
    assert.equal(report.missingRecipientCount, 0);
    assert.equal(report.missingContractCount, 0);
    assert.equal(report.recipients.length, 0);
    assert.equal(report.contracts.length, 0);
    assert.equal(report.byRecipient.length, 0);
    assert.equal(report.byContract.length, 0);
    assert.equal(report.byRecipient.get(RECIPIENT_A), undefined);
    assert.equal(report.byContract.get(CONTRACT_1), undefined);
  }
});

test("feeAccrual: skips null, undefined, and non-object items in array", () => {
  const events = [null, undefined, 42, "invalid", true, {}];
  const report = feeAccrual(events);
  assert.equal(report.total, 0n);
  assert.equal(report.count, 0);
  assert.equal(report.missingAmountCount, 0);
  assert.equal(report.recipients.length, 0);
});

// ── Acceptance Criteria: Non-Admin Events are Ignored ───────────────────────

test("feeAccrual: ignores non-admin events completely", () => {
  const nonAdminEvents = [
    // Market non-admin events
    mockEvent({ name: "claim_created", extra: { claimId: 1, creator: RECIPIENT_A } }),
    mockEvent({ name: "claim_challenged", extra: { claimId: 1, challenger: RECIPIENT_B, stake: 500n } }),
    mockEvent({ name: "claim_resolved", extra: { claimId: 1, winnerSide: 1 } }),
    mockEvent({ name: "claim_cancelled", extra: { claimId: 1 } }),
    mockEvent({ name: "market_settled", extra: { claimId: 1, totalFees: 1000n } }),
    mockEvent({ name: "challenger_paid", extra: { claimId: 1, net: 500n } }),
    mockEvent({ name: "fee_claimed", extra: { recipient: RECIPIENT_A, amount: 2000n } }),
    mockEvent({ name: "withdrawal", extra: { to: RECIPIENT_A, amount: 3000n } }),
    // Squad non-admin events
    mockEvent({ name: "market_created", extra: { marketId: 1 } }),
    mockEvent({ name: "deposited", extra: { marketId: 1, amount: 5000n } }),
    mockEvent({ name: "withdrawn", extra: { marketId: 1, amount: 1000n } }),
    mockEvent({ name: "claimed", extra: { marketId: 1, gross: 100n, fee: 10n, net: 90n } }),
    mockEvent({ name: "fees_claimed", extra: { marketId: 1, fees: 500n } }),
    // Unknown event
    mockEvent({ name: "unknown", extra: { eventName: "random_event" } }),
  ];

  const report = feeAccrual(nonAdminEvents);
  assert.equal(report.total, 0n);
  assert.equal(report.count, 0);
  assert.equal(report.missingAmountCount, 0);
  assert.equal(report.recipients.length, 0);
  assert.equal(report.contracts.length, 0);
});

test("feeAccrual: ignores admin events that are not fee_accrued", () => {
  const adminOtherEvents = [
    mockEvent({ name: "oracle_changed", extra: { newOracle: RECIPIENT_B } }),
    mockEvent({ name: "ownership_transferred", extra: { newOwner: RECIPIENT_B } }),
    mockEvent({ name: "agent_attributed", extra: { agent: RECIPIENT_C } }),
    mockEvent({ name: "fee_policy_set", extra: { feeBps: 200 } }),
    mockEvent({ name: "fee_policy_changed", extra: { feeBps: 300 } }),
    mockEvent({ name: "admin", extra: { action: "pause" } }),
  ];

  const report = feeAccrual(adminOtherEvents);
  assert.equal(report.total, 0n);
  assert.equal(report.count, 0);
  assert.equal(report.missingAmountCount, 0);
});

test("isAdminPayload: helper recognises admin events correctly", () => {
  assert.equal(isAdminPayload({ name: "fee_accrued" }), true);
  assert.equal(isAdminPayload({ name: "admin" }), true);
  assert.equal(isAdminPayload({ name: "oracle_changed" }), true);
  assert.equal(isAdminPayload({ name: "ownership_transferred" }), true);
  assert.equal(isAdminPayload({ name: "agent_attributed" }), true);
  assert.equal(isAdminPayload({ name: "fee_policy_set" }), true);
  assert.equal(isAdminPayload({ name: "fee_policy_updated" }), true);
  assert.equal(isAdminPayload({ name: "admin_action" }), true);

  assert.equal(isAdminPayload({ name: "claim_created" }), false);
  assert.equal(isAdminPayload({ name: "deposited" }), false);
  assert.equal(isAdminPayload({ name: "fee_claimed" }), false);
  assert.equal(isAdminPayload({ name: "unknown" }), false);
  assert.equal(isAdminPayload(null), false);
  assert.equal(isAdminPayload(undefined), false);
  assert.equal(isAdminPayload("string"), false);
});

// ── Complete Payloads ───────────────────────────────────────────────────────

test("feeAccrual: aggregates a single complete fee_accrued event", () => {
  const event = mockEvent({
    recipient: RECIPIENT_A,
    amount: 25_000_000n,
    contractId: CONTRACT_1,
  });

  const report = feeAccrual([event]);
  assert.equal(report.total, 25_000_000n);
  assert.equal(report.totalAmount, 25_000_000n);
  assert.equal(report.count, 1);
  assert.equal(report.validAmountCount, 1);
  assert.equal(report.missingAmountCount, 0);

  // Recipient totals
  assert.equal(report.recipients.length, 1);
  const recA = report.recipients[0];
  assert.equal(recA.recipient, RECIPIENT_A);
  assert.equal(recA.address, RECIPIENT_A);
  assert.equal(recA.total, 25_000_000n);
  assert.equal(recA.count, 1);
  assert.equal(recA.missingAmountCount, 0);
  assert.deepEqual(recA.contracts, [CONTRACT_1]);

  // Contract totals
  assert.equal(report.contracts.length, 1);
  const con1 = report.contracts[0];
  assert.equal(con1.contractId, CONTRACT_1);
  assert.equal(con1.contract, CONTRACT_1);
  assert.equal(con1.total, 25_000_000n);
  assert.equal(con1.count, 1);
  assert.equal(con1.missingAmountCount, 0);
  assert.deepEqual(con1.recipients, [RECIPIENT_A]);

  // Lookup helpers
  assert.equal(report.byRecipient.get(RECIPIENT_A)?.total, 25_000_000n);
  assert.equal(report.byContract.get(CONTRACT_1)?.total, 25_000_000n);
  assert.equal(report.byRecipientMap.get(RECIPIENT_A)?.total, 25_000_000n);
  assert.equal(report.byContractMap.get(CONTRACT_1)?.total, 25_000_000n);
});

test("feeAccrual: aggregates multiple complete events across recipients and contracts", () => {
  const events = [
    mockEvent({ recipient: RECIPIENT_A, amount: 10_000_000n, contractId: CONTRACT_1 }),
    mockEvent({ recipient: RECIPIENT_B, amount: 20_000_000n, contractId: CONTRACT_1 }),
    mockEvent({ recipient: RECIPIENT_A, amount: 15_000_000n, contractId: CONTRACT_2 }),
    mockEvent({ recipient: RECIPIENT_C, amount: 5_000_000n, contractId: CONTRACT_2 }),
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 50_000_000n);
  assert.equal(report.count, 4);
  assert.equal(report.missingAmountCount, 0);

  // Per recipient totals
  assert.equal(report.recipients.length, 3);
  const recA = report.byRecipient.get(RECIPIENT_A);
  assert.ok(recA);
  assert.equal(recA.total, 25_000_000n);
  assert.equal(recA.count, 2);
  assert.deepEqual(recA.contracts, [CONTRACT_1, CONTRACT_2]);

  const recB = report.byRecipient.get(RECIPIENT_B);
  assert.ok(recB);
  assert.equal(recB.total, 20_000_000n);
  assert.equal(recB.count, 1);
  assert.deepEqual(recB.contracts, [CONTRACT_1]);

  const recC = report.byRecipient.get(RECIPIENT_C);
  assert.ok(recC);
  assert.equal(recC.total, 5_000_000n);
  assert.equal(recC.count, 1);
  assert.deepEqual(recC.contracts, [CONTRACT_2]);

  // Per contract totals
  assert.equal(report.contracts.length, 2);
  const con1 = report.byContract.get(CONTRACT_1);
  assert.ok(con1);
  assert.equal(con1.total, 30_000_000n);
  assert.equal(con1.count, 2);
  assert.deepEqual(con1.recipients, [RECIPIENT_A, RECIPIENT_B]);

  const con2 = report.byContract.get(CONTRACT_2);
  assert.ok(con2);
  assert.equal(con2.total, 20_000_000n);
  assert.equal(con2.count, 2);
  assert.deepEqual(con2.recipients, [RECIPIENT_A, RECIPIENT_C]);
});

// ── Partial Payloads ────────────────────────────────────────────────────────

test("feeAccrual: counts events missing amount separately instead of treating as zero", () => {
  const events = [
    // Event with valid amount
    mockEvent({ recipient: RECIPIENT_A, amount: 10_000_000n, contractId: CONTRACT_1 }),
    // Event with missing amount (undefined)
    mockEvent({ recipient: RECIPIENT_A, amount: undefined, contractId: CONTRACT_1 }),
    // Event with null amount
    mockEvent({ recipient: RECIPIENT_B, amount: null, contractId: CONTRACT_2 }),
  ];

  const report = feeAccrual(events);

  // Overall totals
  assert.equal(report.total, 10_000_000n);
  assert.equal(report.count, 3);
  assert.equal(report.validAmountCount, 1);
  assert.equal(report.missingAmountCount, 2);
  assert.equal(report.eventsMissingAmount, 2);
  assert.equal(report.missingAmount, 2);

  // Recipient A had 1 with amount and 1 without
  const recA = report.byRecipient.get(RECIPIENT_A);
  assert.ok(recA);
  assert.equal(recA.total, 10_000_000n);
  assert.equal(recA.count, 2);
  assert.equal(recA.validAmountCount, 1);
  assert.equal(recA.missingAmountCount, 1);

  // Recipient B had only 1 event without amount
  const recB = report.byRecipient.get(RECIPIENT_B);
  assert.ok(recB);
  assert.equal(recB.total, 0n);
  assert.equal(recB.count, 1);
  assert.equal(recB.validAmountCount, 0);
  assert.equal(recB.missingAmountCount, 1);

  // Contract 2 had 1 event without amount
  const con2 = report.byContract.get(CONTRACT_2);
  assert.ok(con2);
  assert.equal(con2.total, 0n);
  assert.equal(con2.missingAmountCount, 1);
});

test("feeAccrual: distinguishes zero amount from missing amount", () => {
  const events = [
    // Explicit zero amount (present and valid)
    mockEvent({ recipient: RECIPIENT_A, amount: 0n }),
    // Missing amount
    mockEvent({ recipient: RECIPIENT_B, amount: undefined }),
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 0n);
  assert.equal(report.count, 2);
  assert.equal(report.validAmountCount, 1);
  assert.equal(report.missingAmountCount, 1);

  const recA = report.byRecipient.get(RECIPIENT_A);
  assert.ok(recA);
  assert.equal(recA.total, 0n);
  assert.equal(recA.validAmountCount, 1);
  assert.equal(recA.missingAmountCount, 0); // 0n is NOT missing

  const recB = report.byRecipient.get(RECIPIENT_B);
  assert.ok(recB);
  assert.equal(recB.total, 0n);
  assert.equal(recB.validAmountCount, 0);
  assert.equal(recB.missingAmountCount, 1); // undefined IS missing
});

test("feeAccrual: handles events missing recipient", () => {
  const events = [
    // Event missing recipient entirely
    mockEvent({ recipient: undefined, amount: 40_000_000n, contractId: CONTRACT_1 }),
    // Event with normal recipient
    mockEvent({ recipient: RECIPIENT_A, amount: 10_000_000n, contractId: CONTRACT_1 }),
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 50_000_000n);
  assert.equal(report.count, 2);
  assert.equal(report.missingRecipientCount, 1);

  // Only RECIPIENT_A is in named recipients
  assert.equal(report.recipients.length, 1);
  assert.equal(report.recipients[0].recipient, RECIPIENT_A);
  assert.equal(report.recipients[0].total, 10_000_000n);

  // Contract 1 received both events
  const con1 = report.byContract.get(CONTRACT_1);
  assert.ok(con1);
  assert.equal(con1.total, 50_000_000n);
  assert.equal(con1.count, 2);
});

test("feeAccrual: handles events missing contractId", () => {
  const events = [
    // Event without contractId
    { payload: { name: "fee_accrued", recipient: RECIPIENT_A, amount: 12_000_000n } },
    // Event with contractId
    mockEvent({ recipient: RECIPIENT_A, amount: 8_000_000n, contractId: CONTRACT_1 }),
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 20_000_000n);
  assert.equal(report.count, 2);
  assert.equal(report.missingContractCount, 1);

  const recA = report.byRecipient.get(RECIPIENT_A);
  assert.ok(recA);
  assert.equal(recA.total, 20_000_000n);
  assert.equal(recA.count, 2);
  assert.deepEqual(recA.contracts, [CONTRACT_1]);

  assert.equal(report.contracts.length, 1);
  assert.equal(report.contracts[0].total, 8_000_000n);
});

test("feeAccrual: handles completely minimal partial payload", () => {
  // Bare minimum fee_accrued payload with neither amount nor recipient
  const events = [{ payload: { name: "fee_accrued" } }];

  const report = feeAccrual(events);
  assert.equal(report.total, 0n);
  assert.equal(report.count, 1);
  assert.equal(report.missingAmountCount, 1);
  assert.equal(report.missingRecipientCount, 1);
  assert.equal(report.missingContractCount, 1);
  assert.equal(report.recipients.length, 0);
  assert.equal(report.contracts.length, 0);
});

test("feeAccrual: accepts raw payload objects without DecodedEvent wrapper", () => {
  const events = [
    { name: "fee_accrued", recipient: RECIPIENT_A, amount: 7_000_000n, contractId: CONTRACT_1 },
    { name: "fee_accrued", recipient: RECIPIENT_B, amount: 3_000_000n, contractId: CONTRACT_1 },
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 10_000_000n);
  assert.equal(report.count, 2);
  assert.equal(report.recipients.length, 2);
  assert.equal(report.byRecipient.get(RECIPIENT_A)?.total, 7_000_000n);
  assert.equal(report.byRecipient.get(RECIPIENT_B)?.total, 3_000_000n);
});

test("feeAccrual: accepts numeric and string amounts from JSON fixtures safely", () => {
  const events = [
    { payload: { name: "fee_accrued", recipient: RECIPIENT_A, amount: 1000 } },
    { payload: { name: "fee_accrued", recipient: RECIPIENT_B, amount: "2500000" } },
    // Malformed string amount -> counted as missing
    { payload: { name: "fee_accrued", recipient: RECIPIENT_C, amount: "not_a_number" } },
  ];

  const report = feeAccrual(events);
  assert.equal(report.total, 2501000n);
  assert.equal(report.byRecipient.get(RECIPIENT_A)?.total, 1000n);
  assert.equal(report.byRecipient.get(RECIPIENT_B)?.total, 2500000n);
  assert.equal(report.byRecipient.get(RECIPIENT_C)?.total, 0n);
  assert.equal(report.byRecipient.get(RECIPIENT_C)?.missingAmountCount, 1);
  assert.equal(report.missingAmountCount, 1);
});

// ── Bigint Precision ────────────────────────────────────────────────────────

test("feeAccrual: preserves full precision on large i128 amounts", () => {
  // Beyond JavaScript Number.MAX_SAFE_INTEGER (2^53 - 1)
  const largeAmount1 = 2n ** 64n + 1234567n;
  const largeAmount2 = 2n ** 80n + 9876543n;
  const expectedTotal = largeAmount1 + largeAmount2;

  const events = [
    mockEvent({ recipient: RECIPIENT_A, amount: largeAmount1 }),
    mockEvent({ recipient: RECIPIENT_B, amount: largeAmount2 }),
  ];

  const report = feeAccrual(events);
  assert.equal(typeof report.total, "bigint");
  assert.equal(report.total, expectedTotal);
  assert.equal(report.byRecipient.get(RECIPIENT_A)?.total, largeAmount1);
  assert.equal(report.byRecipient.get(RECIPIENT_B)?.total, largeAmount2);
});

// ── Deterministic Ordering ──────────────────────────────────────────────────

test("feeAccrual: guarantees deterministic ordering regardless of input sequence", () => {
  const rawEvents = [
    mockEvent({ recipient: RECIPIENT_C, amount: 10_000_000n, contractId: CONTRACT_2 }),
    mockEvent({ recipient: RECIPIENT_A, amount: 30_000_000n, contractId: CONTRACT_1 }),
    mockEvent({ recipient: RECIPIENT_B, amount: 20_000_000n, contractId: CONTRACT_1 }),
    mockEvent({ recipient: RECIPIENT_A, amount: undefined, contractId: CONTRACT_2 }),
  ];

  const reversedEvents = [...rawEvents].reverse();
  const shuffledEvents = [rawEvents[2], rawEvents[0], rawEvents[3], rawEvents[1]];

  const report1 = feeAccrual(rawEvents);
  const report2 = feeAccrual(reversedEvents);
  const report3 = feeAccrual(shuffledEvents);

  // Alphabetical recipient ordering: RECIPIENT_A < RECIPIENT_B < RECIPIENT_C
  const expectedRecipients = [RECIPIENT_A, RECIPIENT_B, RECIPIENT_C];
  assert.deepEqual(report1.recipients.map((r) => r.recipient), expectedRecipients);
  assert.deepEqual(report2.recipients.map((r) => r.recipient), expectedRecipients);
  assert.deepEqual(report3.recipients.map((r) => r.recipient), expectedRecipients);

  // Alphabetical contract ordering: CONTRACT_1 < CONTRACT_2
  const expectedContracts = [CONTRACT_1, CONTRACT_2];
  assert.deepEqual(report1.contracts.map((c) => c.contractId), expectedContracts);
  assert.deepEqual(report2.contracts.map((c) => c.contractId), expectedContracts);
  assert.deepEqual(report3.contracts.map((c) => c.contractId), expectedContracts);

  // Top recipients: sorted by total desc: A (30m) > B (20m) > C (10m)
  assert.deepEqual(report1.topRecipients.map((r) => r.recipient), [RECIPIENT_A, RECIPIENT_B, RECIPIENT_C]);
  assert.deepEqual(report2.topRecipients.map((r) => r.recipient), [RECIPIENT_A, RECIPIENT_B, RECIPIENT_C]);
  assert.deepEqual(report3.topRecipients.map((r) => r.recipient), [RECIPIENT_A, RECIPIENT_B, RECIPIENT_C]);

  // Overall reports are deeply equal across runs
  assert.deepEqual(report1.recipients, report2.recipients);
  assert.deepEqual(report1.recipients, report3.recipients);
  assert.deepEqual(report1.contracts, report2.contracts);
  assert.deepEqual(report1.contracts, report3.contracts);
});

test("feeAccrual: breaks top recipient ties deterministically by address", () => {
  // Both have identical total = 10_000_000n
  const events = [
    mockEvent({ recipient: RECIPIENT_B, amount: 10_000_000n }),
    mockEvent({ recipient: RECIPIENT_A, amount: 10_000_000n }),
  ];

  const report = feeAccrual(events);
  // Equal totals -> tie broken by address ascending: RECIPIENT_A before RECIPIENT_B
  assert.equal(report.topRecipients[0].recipient, RECIPIENT_A);
  assert.equal(report.topRecipients[1].recipient, RECIPIENT_B);
});
