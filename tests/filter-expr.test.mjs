import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_PAYLOAD_SCHEMAS,
  FilterParseError,
  evaluateFilterRule,
  parseFilterExpression,
  parseUsdcStringToUnits,
} from "../dist/notifications/filter-expr.js";

// Helper to construct a minimal DecodedEvent
function mockEvent(source, payload) {
  return {
    source,
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
    payload,
  };
}

// ----------------------------------------------------
// Parser Tests: Valid Rules
// ----------------------------------------------------

test("parseFilterExpression: parses simple event name only", () => {
  const rule = parseFilterExpression("claim_challenged");
  assert.equal(rule.eventName, "claim_challenged");
  assert.equal(rule.condition, undefined);
});

test("parseFilterExpression: parses rule with condition (stake >= 100)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");
  assert.equal(rule.eventName, "claim_challenged");
  assert.ok(rule.condition);
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.field, "stake");
  assert.equal(rule.condition.op, ">=");
  assert.equal(rule.condition.value.kind, "number");
  assert.equal(rule.condition.value.value, 100);
});

test("parseFilterExpression: parses rule with USDC literal suffix (100 USDC)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  assert.equal(rule.eventName, "claim_challenged");
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "usdc");
  assert.equal(rule.condition.value.atomic, 1_000_000_000n);
});

test("parseFilterExpression: parses rule with dollar prefix ($25.50)", () => {
  const rule = parseFilterExpression("deposited where amount > $25.50");
  assert.equal(rule.eventName, "deposited");
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "usdc");
  assert.equal(rule.condition.value.atomic, 255_000_000n);
});

test("parseFilterExpression: parses string comparisons with single and double quotes", () => {
  const rule1 = parseFilterExpression("claim_created where category == 'defi'");
  assert.equal(rule1.condition.type, "comparison");
  assert.equal(rule1.condition.value.kind, "string");
  assert.equal(rule1.condition.value.value, "defi");

  const rule2 = parseFilterExpression('claim_created where category = "governance"');
  assert.equal(rule2.condition.type, "comparison");
  assert.equal(rule2.condition.op, "==");
  assert.equal(rule2.condition.value.value, "governance");
});

test("parseFilterExpression: parses boolean comparison", () => {
  const rule = parseFilterExpression("where active == true");
  assert.equal(rule.eventName, undefined);
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "boolean");
  assert.equal(rule.condition.value.value, true);
});

test("parseFilterExpression: parses compound expressions with and/or and parentheses", () => {
  const expr = "claim_created where (category == 'crypto' or category == 'defi') and claimId > 10";
  const rule = parseFilterExpression(expr);
  assert.equal(rule.eventName, "claim_created");
  assert.equal(rule.condition.type, "logical");
  assert.equal(rule.condition.op, "and");
  assert.equal(rule.condition.left.type, "logical");
  assert.equal(rule.condition.left.op, "or");
  assert.equal(rule.condition.right.type, "comparison");
  assert.equal(rule.condition.right.field, "claimId");
  assert.equal(rule.condition.right.op, ">");
});

// ----------------------------------------------------
// Parser Tests: Error Positions and Validations
// ----------------------------------------------------

test("parseFilterExpression: rejects unknown event name with position", () => {
  try {
    parseFilterExpression("unknown_event where x > 1");
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.equal(err.position, 0);
    assert.match(err.message, /Unknown event name "unknown_event"/);
  }
});

test("parseFilterExpression: rejects unknown field for event with position", () => {
  const input = "claim_challenged where unknown_prop >= 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.equal(err.position, 23); // index where 'unknown_prop' starts
    assert.match(err.message, /Unknown field "unknown_prop" for event "claim_challenged"/);
  }
});

test("parseFilterExpression: rejects type mismatch (string field compared with number)", () => {
  const input = "claim_created where category > 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Field "category" is a string/);
  }
});

test("parseFilterExpression: rejects invalid comparison operator on string (e.g. category > 'abc')", () => {
  const input = "claim_created where category > 'abc'";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Operator ">" cannot be used on string field/);
  }
});

test("parseFilterExpression: rejects type mismatch on number field (claimId == 'abc')", () => {
  const input = "claim_created where claimId == 'abc'";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Field "claimId" is a number/);
  }
});

test("parseFilterExpression: rejects excessive decimal places on USDC amount", () => {
  const input = "claim_challenged where stake >= 1.12345678 USDC";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /exceeds maximum precision of 7 decimals/);
  }
});

test("parseFilterExpression: rejects syntax errors (missing closing parenthesis)", () => {
  const input = "claim_challenged where (stake >= 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Expected closing '\)'/);
  }
});

// ----------------------------------------------------
// Evaluator Tests: BigInt & Comparison Evaluation Table
// ----------------------------------------------------

test("evaluateFilterRule: evaluation table for stake comparison (bigint)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");

  const cases = [
    { stake: 99_999_999n, expected: false },       // 9.9999999 USDC < 100 USDC
    { stake: 999_999_999n, expected: false },      // 99.9999999 USDC < 100 USDC
    { stake: 1_000_000_000n, expected: true },     // 100 USDC == 100 USDC
    { stake: 1_000_000_001n, expected: true },     // 100.0000001 USDC > 100 USDC
    { stake: 5_000_000_000n, expected: true },     // 500 USDC > 100 USDC
  ];

  for (const c of cases) {
    const event = mockEvent("market", {
      name: "claim_challenged",
      claimId: 1,
      challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      stake: c.stake,
    });
    assert.equal(
      evaluateFilterRule(rule, event),
      c.expected,
      `Failed for stake=${c.stake}: expected ${c.expected}`,
    );
  }
});

test("evaluateFilterRule: evaluation table for deposit comparison with explicit USDC literals", () => {
  const rule = parseFilterExpression("deposited where amount >= 50.5 USDC");

  const cases = [
    { amount: 504_999_999n, expected: false },
    { amount: 505_000_000n, expected: true },
    { amount: 505_000_001n, expected: true },
  ];

  for (const c of cases) {
    const event = mockEvent("squad", {
      name: "deposited",
      marketId: 42,
      side: 1,
      participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: c.amount,
      shares: c.amount,
    });
    assert.equal(
      evaluateFilterRule(rule, event),
      c.expected,
      `Failed for amount=${c.amount}`,
    );
  }
});

test("evaluateFilterRule: filters out mismatched event names", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");

  const event = mockEvent("market", {
    name: "claim_created",
    claimId: 1,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    category: "tech",
  });

  assert.equal(evaluateFilterRule(rule, event), false);
});

test("evaluateFilterRule: evaluates logical and/or operations accurately", () => {
  const rule = parseFilterExpression(
    "claim_created where (category == 'crypto' or category == 'defi') and claimId < 50",
  );

  const eventMatch1 = mockEvent("market", {
    name: "claim_created",
    claimId: 10,
    creator: "G...",
    category: "crypto",
  });
  const eventMatch2 = mockEvent("market", {
    name: "claim_created",
    claimId: 49,
    creator: "G...",
    category: "defi",
  });
  const eventFailCategory = mockEvent("market", {
    name: "claim_created",
    claimId: 10,
    creator: "G...",
    category: "sports",
  });
  const eventFailId = mockEvent("market", {
    name: "claim_created",
    claimId: 100,
    creator: "G...",
    category: "crypto",
  });

  assert.equal(evaluateFilterRule(rule, eventMatch1), true);
  assert.equal(evaluateFilterRule(rule, eventMatch2), true);
  assert.equal(evaluateFilterRule(rule, eventFailCategory), false);
  assert.equal(evaluateFilterRule(rule, eventFailId), false);
});

test("parseUsdcStringToUnits: atomic unit conversion utility", () => {
  assert.equal(parseUsdcStringToUnits("1"), 10_000_000n);
  assert.equal(parseUsdcStringToUnits("100"), 1_000_000_000n);
  assert.equal(parseUsdcStringToUnits("0.0000001"), 1n);
  assert.equal(parseUsdcStringToUnits("2.5"), 25_000_000n);
});
