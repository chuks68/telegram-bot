import assert from "node:assert/strict";
import test from "node:test";

import { isOperator } from "../dist/bot.js";

// Telegram sends updates from anonymous group administrators under GroupAnonymousBot (ID: 1087968824)
const ANONYMOUS_GROUP_ADMIN_ID = 1087968824;

function makeConfig(operatorTelegramUserId = null) {
  return {
    operatorTelegramUserId,
  };
}

test("no operator configured: returns false when operatorTelegramUserId is null", () => {
  const config = makeConfig(null);

  // Even if a user id is present, without an operator configured it must be false
  assert.strictEqual(isOperator({ from: { id: 42 } }, config), false);
  assert.strictEqual(isOperator({ from: { id: 123456789 } }, config), false);
  assert.strictEqual(isOperator({ from: { id: 0 } }, config), false);
});

test("matching id: returns true when ctx.from.id matches operatorTelegramUserId", () => {
  const config = makeConfig("42");
  const ctx = { from: { id: 42 } };

  assert.strictEqual(isOperator(ctx, config), true);

  // Large numeric ID
  const largeIdConfig = makeConfig("9876543210");
  assert.strictEqual(isOperator({ from: { id: 9876543210 } }, largeIdConfig), true);
});

test("non-matching id: returns false when ctx.from.id does not match operatorTelegramUserId", () => {
  const config = makeConfig("42");

  assert.strictEqual(isOperator({ from: { id: 43 } }, config), false);
  assert.strictEqual(isOperator({ from: { id: 99999999 } }, config), false);
  assert.strictEqual(isOperator({ from: { id: 420 } }, config), false);
  assert.strictEqual(isOperator({ from: { id: 142 } }, config), false);
});

test("missing from: returns false when ctx has undefined from or no from property", () => {
  const config = makeConfig("42");

  // Missing from property (e.g. channel post updates)
  assert.strictEqual(isOperator({}, config), false);
  assert.strictEqual(isOperator({ from: undefined }, config), false);

  // When no operator configured either
  assert.strictEqual(isOperator({}, makeConfig(null)), false);
  assert.strictEqual(isOperator({ from: undefined }, makeConfig(null)), false);
});

test("anonymous group admin: returns false for Telegram GroupAnonymousBot (from.id 1087968824)", () => {
  const config = makeConfig("42");
  const ctx = { from: { id: ANONYMOUS_GROUP_ADMIN_ID } };

  assert.strictEqual(isOperator(ctx, config), false);

  // Also verify when no operator is configured
  assert.strictEqual(isOperator(ctx, makeConfig(null)), false);
});
