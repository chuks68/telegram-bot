import test from "node:test";
import assert from "node:assert";

import {
  MAX_CATEGORY_LENGTH,
  normalizeCategory,
} from "../src/stellar/category.js";

test("case is folded to lowercase", () => {
  assert.strictEqual(normalizeCategory("Crypto"), "crypto");
  assert.strictEqual(normalizeCategory("CRYPTO"), "crypto");
  assert.strictEqual(normalizeCategory("cRypto"), "crypto");
});

test("leading and trailing whitespace is trimmed", () => {
  assert.strictEqual(normalizeCategory(" crypto"), "crypto");
  assert.strictEqual(normalizeCategory("crypto  "), "crypto");
  assert.strictEqual(normalizeCategory("\t\n crypto \n"), "crypto");
});

test("inner whitespace is collapsed", () => {
  assert.strictEqual(normalizeCategory("defi    fi"), "defi fi");
  assert.strictEqual(normalizeCategory("defi\t\nfi"), "defi fi");
});

test("full-width and compatibility variants are NFKC normalised", () => {
  // Full-width latin letters.
  assert.strictEqual(normalizeCategory("\uFF43\uFF52\uFF59\uFF50\uFF54\uFF4F"), "crypto");
  // Full-width with surrounding whitespace.
  assert.strictEqual(normalizeCategory(" \uFF43 \uFF52 \uFF59 "), "c r y");
});

test("control characters are stripped", () => {
  assert.strictEqual(normalizeCategory("cry\u0000pto"), "crypto");
  assert.strictEqual(normalizeCategory("crypto\u007F"), "crypto");
  assert.strictEqual(normalizeCategory("crypto\u200B"), "crypto");
  assert.strictEqual(normalizeCategory("\uFEFFcrypto\uFEFF"), "crypto");
});

test("very long categories are bounded", () => {
  const long = "a".repeat(MAX_CATEGORY_LENGTH * 2);
  const result = normalizeCategory(long);
  assert.strictEqual(result.length, MAX_CATEGORY_LENGTH);
  assert.strictEqual(result, "a".repeat(MAX_CATEGORY_LENGTH));
});

test("null and undefined become empty strings", () => {
  assert.strictEqual(normalizeCategory(null), "");
  assert.strictEqual(normalizeCategory(undefined), "");
});

test("already normalised categories are stable", () => {
  assert.strictEqual(normalizeCategory("crypto"), "crypto");
  assert.strictEqual(normalizeCategory(normalizeCategory("  Crypto  ")), "crypto");
});
