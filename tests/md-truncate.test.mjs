import assert from "node:assert/strict";
import test from "node:test";

import { truncateMarkdownV2 } from "../dist/notifications/md-truncate.js";

/** Independent MarkdownV2 balance check: even entity parity, balanced links, no dangling escape or open link. */
function isBalancedMdV2(text) {
  let stars = 0;
  let underscores = 0;
  let backticks = 0;
  // 0 = text, 1 = link text, 2 = after `]` awaiting `(`, 3 = inside URL.
  let stage = 0;
  let escape = false;

  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (stage === 3) {
      if (ch === ")") stage = 0;
      continue;
    }
    if (ch === "*") stars += 1;
    else if (ch === "_") underscores += 1;
    else if (ch === "`") backticks += 1;
    else if (ch === "[") stage = 1;
    else if (ch === "]" && stage === 1) stage = 2;
    else if (stage === 2) {
      if (ch === "(") stage = 3;
      else stage = 0;
    }
  }

  return (
    escape === false &&
    stage === 0 &&
    stars % 2 === 0 &&
    underscores % 2 === 0 &&
    backticks % 2 === 0
  );
}

function trailingBackslashRun(text) {
  let run = 0;
  for (let k = text.length - 1; k >= 0 && text[k] === "\\"; k -= 1) run += 1;
  return run;
}

const fixtures = [
  "*Claim #1 resolved* — challenger won with high confidence",
  "_ledger 42_ · [tx](https://example.com/tx/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef)",
  "*Bold* and _italic_ and `code` together",
  "Escaped: \\_underscore\\_ \\*star\\* \\`backtick\\` and \\[bracket\\]",
  "[tx](https://example.com/tx/abcd) with *bold* mid-message and a `trailing code`",
  "Plain text with no entities at all, just words and numbers 12345",
  "*nested *bold* inside* _and _italic_ here_",
  "Link [text](url) then *bold* then _italic_ then `code` then [another](url2)",
  "Ends with escaped backslash \\\\ and escaped star \\*",
];

for (const fixture of fixtures) {
  test(`truncateMarkdownV2 fixture (len=${fixture.length})`, () => {
    // No truncation when the limit fits.
    assert.equal(truncateMarkdownV2(fixture, fixture.length), fixture);
    assert.equal(truncateMarkdownV2(fixture, fixture.length + 10), fixture);

    // Every cut point: bounded, balanced, never a lone backslash or open link.
    for (let max = 1; max <= fixture.length; max += 1) {
      const out = truncateMarkdownV2(fixture, max);
      assert.ok(
        out.length <= max,
        `fixture ${JSON.stringify(fixture)} max=${max}: len ${out.length}`,
      );
      assert.ok(
        isBalancedMdV2(out),
        `fixture ${JSON.stringify(fixture)} max=${max}: not balanced: ${JSON.stringify(out)}`,
      );
      assert.equal(
        trailingBackslashRun(out) % 2,
        0,
        `fixture ${JSON.stringify(fixture)} max=${max}: lone backslash`,
      );
    }
  });
}

test("truncateMarkdownV2 closes open entities", () => {
  const out = truncateMarkdownV2("*unclosed bold", 8);
  assert.ok(isBalancedMdV2(out));
  assert.ok(out.length <= 8);
  assert.ok(out.endsWith("…"));
});

test("truncateMarkdownV2 never cuts inside a link URL", () => {
  const fixture = "before [tx](https://example.com/tx/1234) after";
  for (let max = 1; max <= fixture.length; max += 1) {
    const out = truncateMarkdownV2(fixture, max);
    assert.ok(isBalancedMdV2(out), `max=${max}: ${JSON.stringify(out)}`);
  }
});

test("truncateMarkdownV2 respects custom ellipsis", () => {
  const out = truncateMarkdownV2("*bold* text", 6, "…");
  assert.ok(out.length <= 6);
  assert.ok(isBalancedMdV2(out));
  const out2 = truncateMarkdownV2("*bold* text", 6, "...");
  assert.ok(out2.length <= 6);
  assert.ok(isBalancedMdV2(out2));
});

test("truncateMarkdownV2 validates max", () => {
  assert.throws(() => truncateMarkdownV2("text", 0), RangeError);
  assert.throws(() => truncateMarkdownV2("text", -1), RangeError);
  assert.throws(() => truncateMarkdownV2("text", NaN), RangeError);
});

test("truncateMarkdownV2 tiny max", () => {
  assert.equal(truncateMarkdownV2("*bold*", 1), "…");
  assert.equal(truncateMarkdownV2("hello", 1), "…");
  assert.ok(truncateMarkdownV2("hello", 1).length <= 1);
});
