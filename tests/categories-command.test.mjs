import assert from "node:assert/strict";
import test from "node:test";

import {
  CategoryCounter,
  categoriesMessage,
  createCategoryCounter,
  sanitizeCategory,
  DEFAULT_MAX_CATEGORIES,
  DEFAULT_MAX_LIST_LENGTH,
  MAX_CATEGORY_NAME_LENGTH,
} from "../dist/commands/categories.js";
import { escapeMd } from "../dist/notifications/format.js";

// ── Empty counter ─────────────────────────────────────────────────────────────

test("categoriesMessage: empty counter renders 'no categories recorded yet'", () => {
  const counter = new CategoryCounter();
  const message = categoriesMessage(counter);

  assert.match(message, /\*Claim Categories\*/);
  assert.match(message, /No claim categories recorded yet/i);
});

test("categoriesMessage: empty plain Map or object renders empty notice", () => {
  assert.match(categoriesMessage(new Map()), /No claim categories recorded yet/i);
  assert.match(categoriesMessage({}), /No claim categories recorded yet/i);
});

// ── Unfiltered configuration ──────────────────────────────────────────────────

test("categoriesMessage: unfiltered config lists categories with counts and no (filtered) labels", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("crypto");
  counter.record("sports");

  const message = categoriesMessage(counter, { notificationCategories: [] });

  assert.match(message, /\*Claim Categories\*/);
  assert.match(message, /• `crypto`: 2/);
  assert.match(message, /• `sports`: 1/);
  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: unfiltered config defaults when config is omitted", () => {
  const counter = new CategoryCounter();
  counter.record("prediction");

  const message = categoriesMessage(counter);

  assert.match(message, /• `prediction`: 1/);
  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: MarkdownV2 reserved characters in categories are properly escaped", () => {
  const counter = new CategoryCounter();
  const trickyName = "defi_yield*v1.0-alpha(beta)";
  counter.record(trickyName);

  const message = categoriesMessage(counter);

  assert.ok(
    message.includes(escapeMd(trickyName)),
    `Expected "${escapeMd(trickyName)}" to be in message:\n${message}`,
  );
});

// ── Filtered configuration ────────────────────────────────────────────────────

test("categoriesMessage: filtered config marks categories not in allowlist with (filtered)", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("sports");
  counter.record("governance");

  const config = { notificationCategories: ["crypto", "defi"] };
  const message = categoriesMessage(counter, config);

  // "crypto" is allowed
  assert.match(message, /• `crypto`: 1(?!.*\(filtered\))/);
  assert.ok(!message.includes("`crypto`: 1 \\(filtered\\)"));

  // "sports" and "governance" are filtered
  assert.ok(message.includes("`sports`: 1 \\(filtered\\)"));
  assert.ok(message.includes("`governance`: 1 \\(filtered\\)"));
});

test("categoriesMessage: filtered config matching is case-insensitive and trims whitespace", () => {
  const counter = new CategoryCounter();
  counter.record("Crypto");
  counter.record("DeFi");

  const config = { notificationCategories: [" crypto ", "DEFI"] };
  const message = categoriesMessage(counter, config);

  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: uses counter.config if config argument is omitted", () => {
  const counter = new CategoryCounter({
    config: { notificationCategories: ["allowed_category"] },
  });
  counter.record("allowed_category");
  counter.record("disallowed_category");

  const message = categoriesMessage(counter);

  assert.ok(!message.includes(`\`${escapeMd("allowed_category")}\`: 1 \\(filtered\\)`));
  assert.ok(message.includes(`\`${escapeMd("disallowed_category")}\`: 1 \\(filtered\\)`));
});

// ── Sorting ───────────────────────────────────────────────────────────────────

test("categoriesMessage: sorts primarily by count descending, secondarily by name ascending", () => {
  const counter = new CategoryCounter();
  counter.record("beta"); // count 1
  counter.record("alpha"); // count 2
  counter.record("alpha");
  counter.record("gamma"); // count 2
  counter.record("gamma");
  counter.record("delta"); // count 3
  counter.record("delta");
  counter.record("delta");

  const message = categoriesMessage(counter);
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  // delta (3) -> alpha (2) -> gamma (2) -> beta (1)
  assert.equal(lines.length, 4);
  assert.match(lines[0], /`delta`: 3/);
  assert.match(lines[1], /`alpha`: 2/);
  assert.match(lines[2], /`gamma`: 2/);
  assert.match(lines[3], /`beta`: 1/);
});

// ── Capping list length ───────────────────────────────────────────────────────

test("categoriesMessage: caps list length and renders remaining count indicator", () => {
  const counter = new CategoryCounter();
  for (let i = 1; i <= 25; i++) {
    const name = `cat_${String(i).padStart(2, "0")}`;
    for (let c = 0; c < i; c++) {
      counter.record(name);
    }
  }

  // Default maxListLength is 20
  const message = categoriesMessage(counter);
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  assert.equal(lines.length, DEFAULT_MAX_LIST_LENGTH);
  assert.match(message, /_…and 5 more_/);
});

test("categoriesMessage: honors custom maxListLength option", () => {
  const counter = new CategoryCounter();
  counter.record("first");
  counter.record("first");
  counter.record("second");
  counter.record("third");

  const message = categoriesMessage(counter, undefined, { maxListLength: 2 });
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  assert.equal(lines.length, 2);
  assert.match(message, /_…and 1 more_/);
});

// ── Bounded memory in CategoryCounter ─────────────────────────────────────────

test("CategoryCounter: caps distinct categories and evicts lowest-count entries", () => {
  const counter = new CategoryCounter({ maxCategories: 3 });

  counter.record("a");
  counter.record("a");
  counter.record("b");
  counter.record("b");
  counter.record("c"); // count 1

  assert.equal(counter.size, 3);
  assert.equal(counter.get("c"), 1);

  // Adding "d" should evict "c" (lowest count)
  counter.record("d");
  assert.equal(counter.size, 3);
  assert.equal(counter.has("c"), false);
  assert.equal(counter.has("d"), true);
  assert.equal(counter.get("d"), 1);

  // Increment "d" to count 3
  counter.record("d");
  counter.record("d");

  // Adding "e" should evict "a" (oldest among tie of count 2)
  counter.record("e");
  assert.equal(counter.size, 3);
  assert.equal(counter.has("a"), false);
  assert.equal(counter.has("b"), true);
  assert.equal(counter.has("d"), true);
  assert.equal(counter.has("e"), true);
});

test("CategoryCounter: total tracks all recorded events even across evictions", () => {
  const counter = new CategoryCounter({ maxCategories: 2 });
  counter.record("one");
  counter.record("two");
  counter.record("three"); // evicts one or two
  assert.equal(counter.total, 2); // 2 active entries with count 1 each
});

test("CategoryCounter: clear resets all entries and counters", () => {
  const counter = new CategoryCounter();
  counter.record("test");
  assert.equal(counter.size, 1);
  counter.clear();
  assert.equal(counter.size, 0);
  assert.equal(counter.get("test"), 0);
});

// ── Event ingestion ───────────────────────────────────────────────────────────

test("CategoryCounter: records category from delivered claim_created DecodedEvent", () => {
  const counter = new CategoryCounter();

  const claimCreatedEvent = {
    source: "market",
    contractId: "C123",
    ledger: 100,
    txHash: "0xabc",
    at: 1000,
    eventId: "100-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GAAA",
      category: "prediction_market",
    },
  };

  const recorded = counter.record(claimCreatedEvent);
  assert.equal(recorded, true);
  assert.equal(counter.get("prediction_market"), 1);
  assert.equal(counter.size, 1);
});

test("CategoryCounter: ignores non-claim_created events", () => {
  const counter = new CategoryCounter();

  const challengedEvent = {
    source: "market",
    contractId: "C123",
    ledger: 100,
    txHash: "0xabc",
    at: 1000,
    eventId: "100-1",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      stake: 1000n,
      challenger: "GBBB",
    },
  };

  const recorded = counter.record(challengedEvent);
  assert.equal(recorded, false);
  assert.equal(counter.size, 0);
});

test("CategoryCounter: recordDelivered method delegates to record", () => {
  const counter = createCategoryCounter();
  const event = {
    payload: {
      name: "claim_created",
      claimId: 1,
      creator: "G1",
      category: "climate",
    },
  };

  assert.equal(counter.recordDelivered(event), true);
  assert.equal(counter.get("climate"), 1);
});

// ── Sanitisation & Escaping ───────────────────────────────────────────────────

test("sanitizeCategory: strips control characters, bidi overrides, and collapses whitespace", () => {
  const hostile = "\x00\x1b[31m\u202Ereversed\u202C\t  category  \r\n";
  const cleaned = sanitizeCategory(hostile);

  assert.equal(cleaned, "[31mreversed category");
  assert.ok(!/[\x00-\x1F\x7F\u202A-\u202E]/.test(cleaned));
});

test("sanitizeCategory: caps string length without breaking Unicode code points", () => {
  const longCategory = "🔥".repeat(150);
  const cleaned = sanitizeCategory(longCategory, 10);

  assert.equal(Array.from(cleaned).length, 10);
  assert.equal(cleaned, "🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥");
});

test("sanitizeCategory: rejects empty or non-string inputs", () => {
  assert.equal(sanitizeCategory("   "), "");
  assert.equal(sanitizeCategory(null), "");
  assert.equal(sanitizeCategory(undefined), "");
  assert.equal(sanitizeCategory(123), "");
});

test("CategoryCounter: rejects empty or whitespace-only category strings", () => {
  const counter = new CategoryCounter();
  assert.equal(counter.record(""), false);
  assert.equal(counter.record("   \t  "), false);
  assert.equal(counter.size, 0);
});

// ── Alternate counter shapes ──────────────────────────────────────────────────

test("categoriesMessage: accepts Map<string, number>", () => {
  const map = new Map([
    ["web3", 5],
    ["ai", 10],
  ]);

  const message = categoriesMessage(map);

  assert.match(message, /• `ai`: 10/);
  assert.match(message, /• `web3`: 5/);
});

test("categoriesMessage: accepts plain Record<string, number>", () => {
  const record = { oracle: 7, stellar: 12 };
  const message = categoriesMessage(record);

  assert.match(message, /• `stellar`: 12/);
  assert.match(message, /• `oracle`: 7/);
});

// ── Purity ────────────────────────────────────────────────────────────────────

test("categoriesMessage: pure across multiple calls with same inputs", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("defi");

  const config = { notificationCategories: ["crypto"] };
  const first = categoriesMessage(counter, config);
  const second = categoriesMessage(counter, config);

  assert.equal(first, second);
});
