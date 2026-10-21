import test from "node:test";
import assert from "node:assert";

import {
  eventExplorerUrl,
  explorerKeyboard,
} from "../src/notifications/format.ts";

const VALID_HASH =
  "0x" +
  "abc123"
    .repeat(64)
    .slice(0, 64);

const CHAIN_ID = 137;

const marketEvent = (txHash) => ({
  kind: "market",
  chainId: CHAIN_ID,
  txHash,
  marketId: "42",
});

const squadEvent = (txHash) => ({
  kind: "squad",
  chainId: CHAIN_ID,
  txHash,
  squadId: "7",
});

const USABLE = [
  { name: "valid", txHash: VALID_HASH },
];

const UNUSABLE = [
  { name: "empty", txHash: "" },
  { name: "short", txHash: "0x123" },
  { name: "non-hex", txHash: "0x" + "z".repeat(64) },
];

for (const factory of [markerEvent, squadEvent]) {
  const label = factory === marketEvent ? "market" : "squad";

  test(`$ventExplorerUrl returns exact URL for ${label} event with valid hash`, () => {
    const event = factory(VALID_HASH);
    const url = eventExplorerUrl(event);
    assert.strictEqual(typeof url, "string");
    assert.ok(url.includes(VALID_HASH));
  });

  for (const { txHash, name } of UNUSABLE) {
    test(`$ventExplorerUrl returns no URL for ${label} event with ${name} hash`, () => {
      const event = factory(txHash);
      const url = eventExplorerUrl(event);
      assert.ok(url == null, `expected null/undefined, got ${url}`);
    });

    test(`explorerKeyboard returns no keyboard for ${label} event with ${name} hash`, () => {
      const event = factory(txHash);
      const kb = explorerKeyboard(event);
      assert.ok(kb == null, `expected null/undefined, not ${JSON.stringify(kb)}`);
    });
  }

  test(`explorerKeyboard attaches explorer button for ${label} event with valid hash`, () => {
    const event = factory(VALID_HASH);
    const kb = explorerKeyboard(event);
    assert.ok(kb, "expected a keyboard");
    const buttons = kb.inline_keyboard ?? kb.inlineKeyboard ?? [];
    const flat = buttons.flat();
    const explorer = flat.find((b) => b.url);
    assert.ok(explorer, "expected a button with a URL");
    assert.strictEqual(explorer.url, eventExplorerUrl(event));
  });
}
