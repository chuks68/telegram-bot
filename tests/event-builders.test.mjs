import assert from "node:assert/strict";
import test from "node:test";

import { formatEvent } from "../dist/notifications/format.js";
import {
  marketEvent,
  squadEvent,
  resetEventCounters,
  DEFAULT_MARKET_CONTRACT_ID,
  DEFAULT_SQUAD_CONTRACT_ID,
} from "./helpers/events.mjs";

const CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: DEFAULT_MARKET_CONTRACT_ID,
  squadContractId: DEFAULT_SQUAD_CONTRACT_ID,
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
};

const MARKET_EVENT_NAMES = [
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
];

const SQUAD_EVENT_NAMES = [
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
];

test("marketEvent covers every event name in MarketPayload and renders with formatEvent", () => {
  for (const name of MARKET_EVENT_NAMES) {
    const event = marketEvent(name);
    assert.equal(event.source, "market");
    assert.equal(event.payload.name, name);
    assert.ok(typeof event.ledger === "number");
    assert.ok(typeof event.eventId === "string");

    const message = formatEvent(CONFIG, event);
    assert.ok(typeof message === "string" && message.length > 0, `Expected non-empty rendered message for market ${name}`);
  }
});

test("squadEvent covers every event name in SquadPayload and renders with formatEvent", () => {
  for (const name of SQUAD_EVENT_NAMES) {
    const event = squadEvent(name);
    assert.equal(event.source, "squad");
    assert.equal(event.payload.name, name);
    assert.ok(typeof event.ledger === "number");
    assert.ok(typeof event.eventId === "string");

    const message = formatEvent(CONFIG, event);
    assert.ok(typeof message === "string" && message.length > 0, `Expected non-empty rendered message for squad ${name}`);
  }
});

test("event builders generate increasing ledgers and unique IDs by default", () => {
  resetEventCounters(2000);
  const e1 = marketEvent("claim_created");
  const e2 = squadEvent("market_created");
  const e3 = marketEvent("claim_cancelled");

  assert.equal(e1.ledger, 2000);
  assert.equal(e2.ledger, 2001);
  assert.equal(e3.ledger, 2002);

  assert.notEqual(e1.eventId, e2.eventId);
  assert.notEqual(e2.eventId, e3.eventId);
  assert.match(e1.eventId, /^2000-/);
  assert.match(e2.eventId, /^2001-/);
  assert.match(e3.eventId, /^2002-/);
});

test("event builders respect metadata and payload overrides", () => {
  const customTx = "a".repeat(64);
  const event = marketEvent("claim_challenged", {
    ledger: 42,
    txHash: customTx,
    claimId: 99,
    stake: 50_000_000n,
  });

  assert.equal(event.ledger, 42);
  assert.equal(event.txHash, customTx);
  assert.equal(event.payload.claimId, 99);
  assert.equal(event.payload.stake, 50_000_000n);

  const message = formatEvent(CONFIG, event);
  assert.ok(message.includes("5\\.0000000 USDC"));
  assert.ok(message.includes("#99"));
  assert.ok(message.includes("_ledger 42_"));
});
