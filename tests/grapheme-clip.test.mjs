import test from "node:test";
import assert from "node:assert";
import { clipGraphemes } from "../src/notifications/grapheme.js";

test("ASCII clip matches code-unit behavior", () => {
  assert.strictEqual(clipGraphemes("hello world", 5), "hello");
  assert.strictEqual(clipGraphemes("hello", 10), "hello");
  assert.strictEqual(clipGraphemes("abc", 0), "");
});

test("keeps flags intact", () => {
  const flag = "\u{1F1FA}\u{1F1FB}"; // REGIONAL INDICATOR SEQUENCE
  assert.strictEqual(clipGraphemes(flag + "abc", 1), flag);
  assert.strictEqual(clipGraphemes("ab" + flag, 2), "ab");
});

test("keeps skin-tone emoji intact", () => {
  const thumb = "\u{1F44D}\u{1F3FD}"; // thumbs up + skin tone
  assert.strictEqual(clipGraphemes(thumb, 1), thumb);
  assert.strictEqual(clipGraphemes("this " + thumb, 6), "this " + thumb);
});

test("keeps ZWJ sequences intact", () => {
  const family = "\u{1F469}\u{1F3FD}\u200D\u{1F469}\u{1F3FC}\u200D\u{1F467}\u{1F3FD}"; // woman + woman + house
  assert.strictEqual(clipGraphemes(family, 1), family);
  assert.strictEqual(clipGraphemes("x" + family, 1), "x");
});

test("keeps combining marks with base character", () => {
  const accented = "e\u0301"; // e + combining acute
  assert.strictEqual(clipGraphemes(accented, 1), accented);
  assert.strictEqual(clipGraphemes("ab" + accented, 2), "ab");
});

test("never produces a lone surrogate", () => {
  const emoji = "\u{1F600}"; // grinning face
  const out = clipGraphemes(emoji + emoji, 1);
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = out.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "unpaired high surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = out.charCodeAt(i - 1);
      assert.ok(prev >= 0xd800 && prev <= 0xdbff, "unpaired low surrogate");
    }
  }
});
