import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CATEGORY_ICONS,
  DEFAULT_FALLBACK_ICON,
  iconForCategory,
} from "../dist/notifications/category-icons.js";
import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

const MDV2_RESERVED = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">",
  "#", "+", "-", "=", "|", "{", "}", ".", "!", "\\",
]);

test("category-icons: default map contains key categories with non-empty icons", () => {
  assert.ok(DEFAULT_CATEGORY_ICONS, "DEFAULT_CATEGORY_ICONS is exported");
  assert.equal(typeof DEFAULT_CATEGORY_ICONS, "object");

  assert.equal(DEFAULT_CATEGORY_ICONS.crypto, "🪙");
  assert.equal(DEFAULT_CATEGORY_ICONS.sports, "⚽");
  assert.equal(DEFAULT_CATEGORY_ICONS.politics, "🏛️");
  assert.ok(DEFAULT_FALLBACK_ICON, "DEFAULT_FALLBACK_ICON is defined");
});

test("category-icons: all icons in default map and fallback are free of MarkdownV2 reserved characters", () => {
  const allIcons = [...Object.values(DEFAULT_CATEGORY_ICONS), DEFAULT_FALLBACK_ICON];

  for (const icon of allIcons) {
    for (const ch of icon) {
      assert.equal(
        MDV2_RESERVED.has(ch),
        false,
        `Icon "${icon}" contains reserved MarkdownV2 character "${ch}"`,
      );
    }
  }
});

test("category-icons: matching is case-insensitive", () => {
  assert.equal(iconForCategory("crypto"), "🪙");
  assert.equal(iconForCategory("Crypto"), "🪙");
  assert.equal(iconForCategory("CRYPTO"), "🪙");
  assert.equal(iconForCategory("CrYpTo"), "🪙");

  assert.equal(iconForCategory("sports"), "⚽");
  assert.equal(iconForCategory("Sports"), "⚽");
  assert.equal(iconForCategory("SPORTS"), "⚽");

  assert.equal(iconForCategory("politics"), "🏛️");
  assert.equal(iconForCategory("Politics"), "🏛️");
  assert.equal(iconForCategory("POLITICS"), "🏛️");

  // Leading and trailing whitespace should be tolerated
  assert.equal(iconForCategory("  crypto  "), "🪙");
  assert.equal(iconForCategory("\tsports\n"), "⚽");
});

test("category-icons: unknown categories return the fallback icon", () => {
  assert.equal(iconForCategory("unknown_category"), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory("nonexistent"), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory("some_random_topic"), DEFAULT_FALLBACK_ICON);
});

test("category-icons: empty, whitespace-only, or invalid values return fallback icon", () => {
  assert.equal(iconForCategory(""), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory("   "), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory(undefined), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory(null), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory(123), DEFAULT_FALLBACK_ICON);
  assert.equal(iconForCategory({}), DEFAULT_FALLBACK_ICON);
});

test("category-icons: formatEvent prefixes category icon in MarkdownV2 claim_created line", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  const knownEvent = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GABCD",
      category: "crypto",
    },
  };

  const md = formatEvent(config, knownEvent);
  assert.ok(md, "message rendered");
  assert.ok(md.includes("Category: 🪙 crypto"), "contains icon prefix for known category");

  const unknownEvent = {
    ...knownEvent,
    payload: {
      name: "claim_created",
      claimId: 8,
      creator: "GABCD",
      category: "unheard_of",
    },
  };

  const unknownMd = formatEvent(config, unknownEvent);
  assert.ok(unknownMd, "unknown category message rendered");
  assert.ok(
    unknownMd.includes(`Category: ${DEFAULT_FALLBACK_ICON} unheard\\_of`),
    "unknown category uses fallback icon with escaped category name",
  );
});

test("category-icons: formatPlainTextEvent prefixes category icon in plain text claim_created line", () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  const knownEvent = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GABCD",
      category: "sports",
    },
  };

  const plain = formatPlainTextEvent(config, knownEvent);
  assert.ok(plain, "plain text rendered");
  assert.ok(plain.includes("Category: ⚽ sports"), "plain text contains icon prefix");

  const unknownEvent = {
    ...knownEvent,
    payload: {
      name: "claim_created",
      claimId: 8,
      creator: "GABCD",
      category: "custom_topic",
    },
  };

  const unknownPlain = formatPlainTextEvent(config, unknownEvent);
  assert.ok(unknownPlain, "unknown plain text rendered");
  assert.ok(
    unknownPlain.includes(`Category: ${DEFAULT_FALLBACK_ICON} custom_topic`),
    "plain text uses fallback icon for unknown category",
  );
});
