/**
 * Fuzz tests for validateCallbackData (src/bot.ts).
 *
 * Callback data is attacker-controlled: any user can craft it with a modified
 * client. This suite feeds a deterministic (fixed-seed) stream of hostile
 * payloads — random bytes, near-valid action strings, Unicode, overlong
 * strings, and non-string values — and asserts that the validator:
 *   - never throws,
 *   - always returns a well-formed result object, and
 *   - only ever validates one of the known actions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  CALLBACK_FALLBACK_FEEDBACK,
} from "../dist/bot.js";

const SEED = 0x6d696d72; // "mimr"
const CASES_PER_CATEGORY = 500;
const KNOWN_ACTIONS = new Set(["status", "contracts", "help", "pause", "resume"]);
const ACTIONS = [...KNOWN_ACTIONS];

/** mulberry32 — small deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed) {
  const rand = mulberry32(seed);
  const int = (n) => Math.floor(rand() * n);
  const pick = (arr) => arr[int(arr.length)];

  const randomBytes = () => {
    const len = int(80);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = int(256);
    return Buffer.from(bytes).toString(pick(["utf8", "latin1", "binary"]));
  };

  const mutate = (s) => {
    const chars = [...s];
    const op = int(8);
    const pos = int(chars.length + 1);
    switch (op) {
      case 0: chars.splice(pos, 1); break; // delete
      case 1: chars.splice(pos, 0, String.fromCharCode(32 + int(95))); break; // insert
      case 2: if (chars.length) chars[int(chars.length)] = String.fromCharCode(32 + int(95)); break;
      case 3: return s.toUpperCase();
      case 4: return s + pick(["\u0000", "\n", "\x7f", "\u200b", "\u00a0", "\ufeff"]);
      case 5: return pick(["\u0000", "\t", "\u202e", "\u0301"]) + s;
      case 6: return s.replace(/s/g, "\u0455"); // Cyrillic homoglyph
      default: return s + s;
    }
    return chars.join("");
  };

  const nearValid = () => {
    const a = pick(ACTIONS);
    const forms = [
      a,
      `mimir:${a}`,
      `${a}:refresh`,
      `{"action":"${a}"}`,
      `mimir:${a}x`,
      `x${a}`,
      `{"action":["${a}"]}`,
      `{"action":"${a}"`,
      `{"Action":"${a}"}`,
      `::${a}`,
      `MIMIR:${a}`,
      `${a}${a}`,
    ];
    const base = pick(forms);
    return rand() < 0.6 ? mutate(base) : base;
  };

  const unicode = () => {
    const len = 1 + int(40);
    let s = "";
    for (let i = 0; i < len; i++) {
      const r = rand();
      if (r < 0.3) s += String.fromCodePoint(0x1f300 + int(0x300)); // emoji
      else if (r < 0.5) s += String.fromCharCode(0xd800 + int(0x800)); // lone surrogates
      else if (r < 0.7) s += String.fromCodePoint(0x300 + int(0x70)); // combining marks
      else if (r < 0.85) s += String.fromCodePoint(0x4e00 + int(0x5000)); // CJK
      else s += pick(["\u200b", "\u202e", "\u2028", "\u3000", "\ufeff", "\u00a0"]);
    }
    return rand() < 0.3 ? `${pick(ACTIONS)}${s}` : s;
  };

  const overlong = () => {
    const unit = pick([pick(ACTIONS), "a", "\u00e9", "\u{1f600}", "mimir:status ", "{\"action\":\"help\"}"]);
    let s = `${pick(["", "mimir:", "{\"action\":\""])}${pick(ACTIONS)}`;
    while (Buffer.byteLength(s, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES + int(200)) s += unit;
    return s;
  };

  const nonString = () => {
    const values = [
      null,
      undefined,
      0,
      -1,
      NaN,
      Infinity,
      true,
      false,
      12345678901234567890n,
      Symbol("status"),
      {},
      { action: pick(ACTIONS) },
      [pick(ACTIONS)],
      new String(pick(ACTIONS)),
      Buffer.from(pick(ACTIONS)),
      () => "status",
      Object.create(null),
      { toString: () => "status", valueOf: () => "status" },
      { toString() { throw new Error("boom"); } },
      new Proxy({}, { get() { throw new Error("trap"); } }),
      new Date(int(1e12)),
      /status/,
    ];
    return pick(values);
  };

  return { randomBytes, nearValid, unicode, overlong, nonString };
}

function describe(input) {
  try {
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "symbol" || typeof input === "bigint") return String(input);
    return `${typeof input}:${Object.prototype.toString.call(input)}`;
  } catch {
    return typeof input;
  }
}

function checkResult(input, result) {
  const label = describe(input);
  assert.equal(typeof result, "object", `non-object result for ${label}`);
  assert.notEqual(result, null, `null result for ${label}`);
  assert.equal(typeof result.ok, "boolean", `missing ok flag for ${label}`);

  if (result.ok) {
    assert.equal(typeof input, "string", `non-string validated: ${label}`);
    assert.ok(result.action && typeof result.action === "object", `missing action for ${label}`);
    assert.ok(KNOWN_ACTIONS.has(result.action.type), `unknown action ${result.action.type} for ${label}`);
    assert.equal(result.action.raw, input, `raw mismatch for ${label}`);
    assert.ok(Buffer.byteLength(input, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES, `overlong accepted: ${label}`);
    assert.ok(!/[\x00-\x1F\x7F]/.test(input), `control chars accepted: ${label}`);
  } else {
    assert.equal(typeof result.reason, "string", `missing reason for ${label}`);
    assert.ok(result.reason.length > 0, `empty reason for ${label}`);
    assert.equal(result.fallbackText, CALLBACK_FALLBACK_FEEDBACK, `bad fallbackText for ${label}`);
  }
}

function runCategory(name, offset) {
  const gen = makeGen(SEED + offset);
  let count = 0;
  for (let i = 0; i < CASES_PER_CATEGORY; i++) {
    const input = gen[name]();
    let result;
    assert.doesNotThrow(() => {
      result = validateCallbackData(input);
    }, `validateCallbackData threw for ${describe(input)}`);
    checkResult(input, result);
    count++;
  }
  return count;
}

const CATEGORIES = ["randomBytes", "nearValid", "unicode", "overlong", "nonString"];

test("callback fuzz: seeded hostile payloads never throw and only known actions validate", () => {
  let total = 0;
  CATEGORIES.forEach((name, idx) => {
    total += runCategory(name, idx);
  });
  assert.ok(total >= 2000, `expected at least 2000 cases, ran ${total}`);
});

test("callback fuzz: generator is deterministic for a fixed seed", () => {
  for (const name of ["randomBytes", "nearValid", "unicode", "overlong"]) {
    const a = makeGen(SEED);
    const b = makeGen(SEED);
    for (let i = 0; i < 50; i++) assert.equal(a[name](), b[name]());
  }
});

test("callback fuzz: overlong payloads are always rejected", () => {
  const gen = makeGen(SEED + 99);
  for (let i = 0; i < 200; i++) {
    const input = gen.overlong();
    const result = validateCallbackData(input);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "exceeds-max-length");
  }
});

test("callback fuzz: non-string payloads are always rejected", () => {
  const gen = makeGen(SEED + 100);
  for (let i = 0; i < 200; i++) {
    const input = gen.nonString();
    const result = validateCallbackData(input);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-or-non-string");
  }
});

test("callback fuzz: canonical known actions still validate", () => {
  for (const a of ACTIONS) {
    for (const form of [a, `mimir:${a}`, `${a}:refresh`, `{"action":"${a}"}`]) {
      const result = validateCallbackData(form);
      assert.equal(result.ok, true, `expected ${form} to validate`);
      assert.equal(result.action.type, a);
    }
  }
});
