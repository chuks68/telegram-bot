import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeMd,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";

function assertValidChunks(chunks, limit) {
  assert.ok(chunks.length > 0);
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(chunk.length > 0 && chunk.length <= limit, `chunk ${index}: length ${chunk.length}`);
    // Iteration combines valid surrogate pairs into a single code point;
    // anything left in the surrogate range must be an unpaired code unit.
    for (const character of chunk) {
      const codePoint = character.codePointAt(0);
      assert.ok(codePoint < 0xd800 || codePoint > 0xdfff, `chunk ${index}: lone surrogate`);
    }
    const trailingSlashes = chunk.match(/\\+$/)?.[0].length ?? 0;
    assert.equal(trailingSlashes % 2, 0, `chunk ${index}: incomplete MarkdownV2 escape`);
  }
}

function assertSafeChunks(text, limit = TELEGRAM_MAX_MESSAGE_LENGTH, separator = "") {
  const chunks = splitTelegramMessage(text, limit);
  assertValidChunks(chunks, limit);
  assert.equal(chunks.join(separator), text, "splitting must preserve the input apart from separator newlines");
  return chunks;
}

const unicodeCases = [
  ["claim emoji", "🆕"],
  ["challenge emoji with variation selector", "⚔️"],
  ["emoji with skin tone and ZWJ", "👩🏽‍💻"],
  ["flag emoji", "🇳🇬"],
  ["combining accent", "e\u0301"],
  ["stacked combining marks", "e\u0301\u0327"],
  ["supplementary combining mark", "\u{1d165}"],
];

for (const limit of [16, TELEGRAM_MAX_MESSAGE_LENGTH]) {
  for (const offset of [-1, 0, 1]) {
    for (const [label, unicode] of unicodeCases) {
      test(`split Unicode: ${label} starts at limit${offset < 0 ? "" : "+"}${offset} (limit=${limit})`, () => {
        const text = "a".repeat(limit + offset) + unicode + "z".repeat(limit + 3);
        const chunks = assertSafeChunks(text, limit);
        assert.ok(chunks.length > 1);
      });
    }

    test(`split escapes: escaped punctuation at offset ${offset} (limit=${limit})`, () => {
      const text = "a".repeat(limit + offset) + escapeMd("!_*[]()~`>#+-=|{}.") + "z".repeat(limit);
      assertSafeChunks(text, limit);
    });

    // Even trailing runs represent complete escaped backslashes; odd runs
    // would leave an escape unfinished, including runs longer than one slash.
    for (const slashes of [2, 3, 4, 5]) {
      test(`split escapes: ${slashes} backslashes end at limit${offset < 0 ? "" : "+"}${offset} (limit=${limit})`, () => {
        const escaped = "\\".repeat(slashes) + (slashes % 2 ? "!" : "x");
        const text = "a".repeat(limit + offset - slashes) + escaped + "z".repeat(limit);
        const chunks = assertSafeChunks(text, limit);
        if (offset === 0 && slashes % 2 === 0) {
          assert.equal(chunks[0].length, limit, "complete escaped backslashes stay at the original boundary");
        }
      });
    }

    test(`split Unicode and escapes: backtracking before an escaped emoji at offset ${offset} (limit=${limit})`, () => {
      const text = "a".repeat(limit + offset - 1) + "\\🆕" + "z".repeat(limit);
      assertSafeChunks(text, limit);
    });
  }
}

for (const offset of [-1, 0, 1]) {
  test(`split Unicode: total UTF-16 length is limit${offset < 0 ? "" : "+"}${offset}`, () => {
    const text = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + offset - 2) + "🆕";
    const chunks = assertSafeChunks(text);
    assert.equal(chunks.length, offset <= 0 ? 1 : 2);
  });
}

test("split Unicode: repeated emoji remain safe at every successive hard cut", () => {
  const text = ("a🆕e\u0301👩🏽‍💻" + escapeMd("!\\")).repeat(1_000);
  assert.ok(assertSafeChunks(text).length >= 4);
});

test("split Unicode: newline splitting preserves the documented separator", () => {
  const first = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 4) + "🆕" + escapeMd("!");
  const second = "e\u0301".repeat(TELEGRAM_MAX_MESSAGE_LENGTH / 2);
  const third = "⚔️" + escapeMd("\\") + "🇳🇬";
  const text = [first, second, third].join("\n");
  assert.deepEqual(assertSafeChunks(text, TELEGRAM_MAX_MESSAGE_LENGTH, "\n"), [first, second, third]);
});

test("split Unicode: backing away from a surrogate pair also preserves a following newline", () => {
  const first = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 1);
  const text = first + "🆕\n" + "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
  // Only the newline chosen as a split separator is omitted; the hard cut
  // before the emoji does not add a separator or remove any other characters.
  const chunks = splitTelegramMessage(text);
  assertValidChunks(chunks, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.deepEqual(chunks, [first, "🆕", "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH)]);
  assert.equal(chunks[0] + chunks[1] + "\n" + chunks[2], text);
});

test("split Unicode: a two-unit limit can hold whole emoji and MarkdownV2 escapes", () => {
  assert.deepEqual(assertSafeChunks("🆕🆕", 2), ["🆕", "🆕"]);
  assert.deepEqual(assertSafeChunks("\\!\\!", 2), ["\\!", "\\!"]);
});

test("split Unicode: an unsafe early newline falls back to a safe hard cut", () => {
  const first = "\\\n" + "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 3);
  const text = first + "🆕" + "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
  const chunks = assertSafeChunks(text);
  assert.equal(chunks[0], first);
});

test("split Unicode: an undersized limit rejects an indivisible code point or escape", () => {
  assert.throws(() => splitTelegramMessage("🆕", 1), RangeError);
  assert.throws(() => splitTelegramMessage("\\!", 1), RangeError);
  assert.throws(() => splitTelegramMessage("\\🆕", 2), RangeError);
  assert.deepEqual(splitTelegramMessage("abc", 1), ["a", "b", "c"]);
});
