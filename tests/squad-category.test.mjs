import assert from "node:assert/strict";
import test from "node:test";

import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

const config = {
  chatIds: ["-1001234567890"],
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function squadMarketCreated(category) {
  return {
    source: "squad",
    contractId: "squad",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "market_created",
      marketId: 7,
      captain: "GABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDE",
      deadline: 1_800_000_000,
      feeBps: 25,
      question: "Will it rain?",
      ...(category === undefined ? {} : { category }),
    },
  };
}

const CATEGORY_LINE = "\nCategory: Football";

test("squad market_created MarkdownV2 shows the category line only when non-empty", () => {
  const present = formatEvent(config, squadMarketCreated("Football"));
  assert.ok(present !== null, "Expected a non-null MarkdownV2 message");
  assert.ok(present.includes(CATEGORY_LINE), "category line missing when category is present");

  for (const value of ["", null, undefined]) {
    const message = formatEvent(config, squadMarketCreated(value));
    assert.ok(message !== null, `Expected a non-null MarkdownV2 message for category ${String(value)}`);
    assert.ok(!message.includes("Category:"), `category line must not appear for category ${String(value)}`);
  }
});

test("squad market_created plain text shows the category line only when non-empty", () => {
  const present = formatPlainTextEvent(config, squadMarketCreated("Football"));
  assert.ok(present !== null, "Expected a non-null plain-text message");
  assert.ok(present.includes(CATEGORY_LINE), "category line missing when category is present");

  for (const value of ["", null, undefined]) {
    const message = formatPlainTextEvent(config, squadMarketCreated(value));
    assert.ok(message !== null, `Expected a non-null plain-text message for category ${String(value)}`);
    assert.ok(!message.includes("Category:"), `category line must not appear for category ${String(value)}`);
  }
});
