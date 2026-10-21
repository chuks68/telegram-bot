/**
 * Pin escapeMd against every MarkdownV2 reserved character.
 *
 * The reserved set comes straight from the Telegram Bot API docs:
 * https://core.telegram.org/bots/api#markdownv2-style
 * The backslash is also reserved (it is the escape prefix itself).
 *
 * Each character gets its own assertion so a regression names the exact
 * character that broke, not just "some escape test failed".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { escapeMd } from "../dist/notifications/format.js";

// Every character Telegram reserves in MarkdownV2, plus the backslash.
// Order matches the Bot API documentation table.
const RESERVED = [
  ["underscore",        "_"],
  ["asterisk",          "*"],
  ["open bracket",      "["],
  ["close bracket",     "]"],
  ["open paren",        "("],
  ["close paren",       ")"],
  ["tilde",             "~"],
  ["backtick",          "`"],
  ["greater-than",      ">"],
  ["hash",              "#"],
  ["plus",              "+"],
  ["hyphen/minus",      "-"],
  ["equals",            "="],
  ["pipe",              "|"],
  ["open brace",        "{"],
  ["close brace",       "}"],
  ["period",            "."],
  ["exclamation mark",  "!"],
  ["backslash",         "\\"],
];

// ── one assertion per reserved character ────────────────────────────────────

for (const [name, char] of RESERVED) {
  test(`escapeMd escapes ${name} (${char === "\\" ? "\\\\" : char}) with a single backslash`, () => {
    const result = escapeMd(char);
    assert.equal(
      result,
      `\\${char}`,
      `expected "\\${char === "\\" ? "\\\\" : char}" but got "${result}"`,
    );
  });
}

// ── ASCII letters and digits are left untouched ──────────────────────────────

test("escapeMd leaves ASCII letters untouched", () => {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  assert.equal(escapeMd(letters), letters);
});

test("escapeMd leaves ASCII digits untouched", () => {
  const digits = "0123456789";
  assert.equal(escapeMd(digits), digits);
});

// ── non-idempotence: escaping an already-escaped string escapes the backslash ─

test("escapeMd is not idempotent: escaping twice escapes the backslash prefix", () => {
  // First pass: "_" → "\\_"  (2 real chars: backslash + underscore)
  const once = escapeMd("_");
  assert.equal(once, "\\_");
  assert.equal(once.length, 2);

  // Second pass escapes each reserved char in "\\_":
  //   "\" (reserved) → "\\" and "_" (reserved) → "\_"
  //   real result: \, \, \, _  (4 chars)
  const twice = escapeMd(once);
  assert.equal(twice, "\\\\\\_");   // JS literal "\\\\\\_" = real chars: \, \, \, _
  assert.equal(twice.length, 4);

  // The two results must differ.
  assert.notEqual(once, twice);
});

test("escapeMd is not idempotent: all reserved chars grow on a second pass", () => {
  for (const [name, char] of RESERVED) {
    const once = escapeMd(char);        // e.g. "\\_"
    const twice = escapeMd(once);       // e.g. "\\\\_"

    assert.notEqual(
      once,
      twice,
      `expected second pass to differ from first for ${name}`,
    );

    // The second pass must start with the escaped backslash that was the
    // escape prefix from the first pass.
    assert.ok(
      twice.startsWith("\\\\"),
      `expected second pass to start with "\\\\" for ${name}, got "${twice}"`,
    );
  }
});
