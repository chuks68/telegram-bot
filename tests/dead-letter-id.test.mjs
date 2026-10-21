/**
 * Tests for makeEntryId stability and dead-letter entry ID properties.
 *
 * Verifies that dead-letter entry IDs stay deterministic across identical inputs,
 * vary across differing dimensions (source/chat, ledger, event id/name, text),
 * and do not leak raw chat IDs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEntryId } from "../dist/deadLetter.js";

test("makeEntryId returns identical IDs for identical inputs across invocations", () => {
  const id1 = makeEntryId("chat-12345", 100, "claim_created", "Hello world notification");
  const id2 = makeEntryId("chat-12345", 100, "claim_created", "Hello world notification");
  assert.equal(id1, id2);
  assert.equal(typeof id1, "string");
  assert.ok(id1.length > 0);
});

test("makeEntryId changes when the chat/source changes", () => {
  const idBase = makeEntryId("chat-100", 42, "payout_processed", "Payout sent");
  const idDifferentChat = makeEntryId("chat-200", 42, "payout_processed", "Payout sent");
  assert.notEqual(idBase, idDifferentChat);
});

test("makeEntryId changes when the ledger changes", () => {
  const idLedger1 = makeEntryId("market", 1000, "trade_executed", "Trade executed at 1.5");
  const idLedger2 = makeEntryId("market", 1001, "trade_executed", "Trade executed at 1.5");
  assert.notEqual(idLedger1, idLedger2);
});

test("makeEntryId changes when the event ID or event name changes", () => {
  const idEventA = makeEntryId("market", 500, "event_order_created", "Order created");
  const idEventB = makeEntryId("market", 500, "event_order_cancelled", "Order created");
  assert.notEqual(idEventA, idEventB);
});

test("makeEntryId changes when message text differs", () => {
  const idText1 = makeEntryId("squad", 300, "member_joined", "User Alice joined");
  const idText2 = makeEntryId("squad", 300, "member_joined", "User Bob joined");
  assert.notEqual(idText1, idText2);
});

test("dead-letter IDs contain no raw chat ID", () => {
  const rawChatId = "-1001987654321";
  const channelSource = "channel";
  const id = makeEntryId(channelSource, 777, "alert_triggered", `Alert for chat ${rawChatId}`);

  assert.equal(id.includes(rawChatId), false);
  assert.doesNotMatch(id, new RegExp(rawChatId.replace("-", "\\-")));
});

test("makeEntryId matches expected exact structure format", () => {
  const id = makeEntryId("market", 42, "claim_cancelled", "hello");
  const parts = id.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "market");
  assert.equal(parts[1], "42");
  assert.equal(parts[2], "claim_cancelled");
  // Text hash component is 8 hex characters
  assert.match(parts[3], /^[0-9a-f]{8}$/);
});
