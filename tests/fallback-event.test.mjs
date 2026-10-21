import assert from "node:assert/strict";
import test from "node:test";

import { formatFallbackEvent } from "../dist/notifications/format.js";

const config = {
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
};

const payloadSentinel = "RAW-PAYLOAD-MUST-NOT-APPEAR ".repeat(300);

function event(payload, txHash = "") {
  return {
    source: "market",
    contractId: "contract",
    ledger: 55,
    txHash,
    at: 0,
    eventId: "55-0",
    payload,
  };
}

function assertBoundedWithoutPayload(result) {
  assert.ok(result.length <= 4000, "fallback must stay below Telegram's message limit");
  assert.equal(
    result.includes("RAW-PAYLOAD-MUST-NOT-APPEAR"),
    false,
    "fallback must not dump the raw payload",
  );
}

test("formatFallbackEvent renders unknown events without dumping their payload", () => {
  const result = formatFallbackEvent(
    config,
    event({
      name: "unknown",
      eventName: "future_event",
      reason: "no decoder",
      raw: payloadSentinel,
    }),
  );

  assert.equal(
    result,
    "⚠️ *Event Notification Fallback* \\(market\\)\n" +
      "Contract: `contract` · Ledger: 55\n" +
      "Reason: _malformed payload_",
  );
  assertBoundedWithoutPayload(result);
});

test("formatFallbackEvent renders admin events without dumping their payload", () => {
  const result = formatFallbackEvent(
    config,
    event({
      name: "admin",
      action: "set_paused",
      details: { privateData: payloadSentinel },
    }),
    "admin event",
  );

  assert.equal(
    result,
    "⚠️ *Event Notification Fallback* \\(market\\)\n" +
      "Contract: `contract` · Ledger: 55\n" +
      "Reason: _admin event_",
  );
  assertBoundedWithoutPayload(result);
});

test("formatFallbackEvent keeps an unusable transaction hash out of the URL", () => {
  const result = formatFallbackEvent(
    config,
    event({ name: "unknown", raw: payloadSentinel }, "not-a-valid-hash"),
    "no decoder",
  );

  assert.equal(
    result,
    "⚠️ *Event Notification Fallback* \\(market\\)\n" +
      "Contract: `contract` · Ledger: 55 · [tx]()\n" +
      "Reason: _no decoder_",
  );
  assertBoundedWithoutPayload(result);
});